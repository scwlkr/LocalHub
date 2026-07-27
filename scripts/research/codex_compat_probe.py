#!/usr/bin/env python3
"""Cross-platform Codex Responses compatibility probe for Wayfinder evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def sha256_if_present(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def codex_state() -> dict[str, str | None]:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    return {
        "config": sha256_if_present(codex_home / "config.toml"),
        "auth": sha256_if_present(codex_home / "auth.json"),
    }


def sse_event(event: dict[str, Any]) -> bytes:
    event_type = event["type"]
    return f"event: {event_type}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n".encode()


def created(response_id: str) -> dict[str, Any]:
    return {"type": "response.created", "response": {"id": response_id}}


def completed(response_id: str) -> dict[str, Any]:
    return {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "usage": {
                "input_tokens": 0,
                "input_tokens_details": None,
                "output_tokens": 0,
                "output_tokens_details": None,
                "total_tokens": 0,
            },
        },
    }


@dataclass
class FakeState:
    mode: str
    command: str = ""
    workdir: str = ""
    requests: list[dict[str, Any]] = field(default_factory=list)
    first_request: threading.Event = field(default_factory=threading.Event)
    disconnected: threading.Event = field(default_factory=threading.Event)


class FakeResponsesServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, state: FakeState):
        super().__init__(("127.0.0.1", 0), FakeResponsesHandler)
        self.state = state


class FakeResponsesHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    @property
    def state(self) -> FakeState:
        return self.server.state  # type: ignore[attr-defined, no-any-return]

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models":
            body = json.dumps({"object": "list", "data": [{"id": "localhub-probe"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"invalid_json": True}
        function_outputs = [
            str(item.get("output", ""))
            for item in body.get("input", [])
            if isinstance(item, dict) and item.get("type") == "function_call_output"
        ]
        lowered_outputs = [output.lower() for output in function_outputs]
        self.state.requests.append(
            {
                "path": self.path,
                "authorization_header": self.headers.get("Authorization") is not None,
                "authorization_scheme": (self.headers.get("Authorization") or "").partition(" ")[0] or None,
                "authorization_value_length": len(self.headers.get("Authorization") or ""),
                "stream": body.get("stream"),
                "tool_types": sorted({tool.get("type") for tool in body.get("tools", [])}),
                "tool_names": sorted(
                    tool.get("name") for tool in body.get("tools", []) if tool.get("name")
                ),
                "has_function_output": any(
                    item.get("type") == "function_call_output" and item.get("call_id") == "localhub-call-1"
                    for item in body.get("input", [])
                    if isinstance(item, dict)
                ),
                "function_output_excerpt": [output[:500] for output in function_outputs],
                "function_output_reports_success": any(
                    marker in output
                    for output in lowered_outputs
                    for marker in ("exit code: 0", "exited with code 0")
                ),
                "function_output_reports_denial": any(
                    marker in output.lower()
                    for output in function_outputs
                    for marker in (
                        "operation not permitted",
                        "permission denied",
                        "access is denied",
                        "exit code: 1",
                        "exited with code 1",
                    )
                ),
            }
        )
        self.state.first_request.set()

        if self.state.mode == "context":
            payload = json.dumps(
                {
                    "error": {
                        "message": "LocalHub probe: context length exceeded",
                        "type": "invalid_request_error",
                        "code": "context_length_exceeded",
                    }
                }
            ).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        if self.state.mode == "cancel":
            try:
                for _ in range(240):
                    self.wfile.write(b": localhub-queue-keepalive\n\n")
                    self.wfile.flush()
                    time.sleep(0.25)
            except (BrokenPipeError, ConnectionResetError):
                self.state.disconnected.set()
            return

        try:
            for _ in range(10):
                self.wfile.write(b": localhub-queue-keepalive\n\n")
                self.wfile.flush()
                time.sleep(0.5)
            request_number = len(self.state.requests)
            if request_number == 1:
                arguments = json.dumps(
                    {"command": self.state.command, "workdir": self.state.workdir, "timeout_ms": 10_000}
                )
                events = [
                    created("resp-localhub-tool"),
                    {
                        "type": "response.output_item.done",
                        "item": {
                            "type": "function_call",
                            "call_id": "localhub-call-1",
                            "name": "shell_command",
                            "arguments": arguments,
                        },
                    },
                    completed("resp-localhub-tool"),
                ]
            else:
                events = [
                    created("resp-localhub-final"),
                    {
                        "type": "response.output_item.done",
                        "item": {
                            "type": "message",
                            "role": "assistant",
                            "id": "msg-localhub-final",
                            "content": [{"type": "output_text", "text": "probe complete"}],
                        },
                    },
                    completed("resp-localhub-final"),
                ]
            for event in events:
                self.wfile.write(sse_event(event))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.state.disconnected.set()


def provider_command(codex: str, base_url: str, workspace: Path, prompt: str) -> list[str]:
    settings = [
        'approval_policy="never"',
        'model_provider="localhub"',
        'model_providers.localhub.name="LocalHub"',
        f'model_providers.localhub.base_url="{base_url}"',
        'model_providers.localhub.wire_api="responses"',
        "model_providers.localhub.requires_openai_auth=false",
        "model_providers.localhub.supports_websockets=false",
        "model_providers.localhub.request_max_retries=0",
        "model_providers.localhub.stream_max_retries=0",
        "model_context_window=32768",
        'service_tier="default"',
        "features.fast_mode=false",
        "features.unified_exec=false",
        "features.plugins=false",
        "features.remote_plugin=false",
        "features.skill_search=false",
        "features.multi_agent=false",
        "mcp_servers={}",
        'web_search="disabled"',
        "shell_environment_policy.ignore_default_excludes=false",
    ]
    command = [
        codex,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--strict-config",
        "--json",
        "--color",
        "never",
        "--cd",
        str(workspace),
        "--model",
        "localhub-probe",
        "--sandbox",
        "workspace-write",
    ]
    for setting in settings:
        command.extend(["--config", setting])
    command.append(prompt)
    return command


def run_codex(codex: str, base_url: str, workspace: Path, prompt: str, timeout: float = 90) -> subprocess.CompletedProcess[str]:
    child_env = {key: value for key, value in os.environ.items() if not key.startswith("CODEX_")}
    isolated_codex_home = workspace.parent / "codex-home"
    isolated_codex_home.mkdir(exist_ok=True)
    child_env["CODEX_HOME"] = str(isolated_codex_home)
    return subprocess.run(
        provider_command(codex, base_url, workspace, prompt),
        env=child_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def fake_case(codex: str, mode: str, command: str, workspace: Path) -> tuple[subprocess.CompletedProcess[str], FakeState]:
    state = FakeState(mode=mode, command=command, workdir=str(workspace))
    server = FakeResponsesServer(state)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        result = run_codex(codex, base_url, workspace, "Run the requested compatibility probe.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    return result, state


def cancel_case(codex: str, workspace: Path) -> dict[str, Any]:
    state = FakeState(mode="cancel")
    server = FakeResponsesServer(state)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/v1"
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    child_env = {key: value for key, value in os.environ.items() if not key.startswith("CODEX_")}
    isolated_codex_home = workspace.parent / "codex-home"
    isolated_codex_home.mkdir(exist_ok=True)
    child_env["CODEX_HOME"] = str(isolated_codex_home)
    process = subprocess.Popen(
        provider_command(codex, base_url, workspace, "Wait for the queued compatibility probe."),
        env=child_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creationflags,
    )
    state.first_request.wait(timeout=30)
    time.sleep(1.0)
    if process.poll() is None:
        process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    try:
        process.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        if process.poll() is None:
            process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)
    state.disconnected.wait(timeout=5)
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    return {
        "request_started": state.first_request.is_set(),
        "server_observed_disconnect": state.disconnected.is_set(),
        "client_exit_nonzero": process.returncode not in (None, 0),
    }


def fake_suite(codex: str) -> dict[str, Any]:
    before = codex_state()
    with (
        tempfile.TemporaryDirectory(prefix="localhub-codex-probe-") as root_raw,
        tempfile.TemporaryDirectory(prefix="localhub-codex-outside-", dir=Path.home()) as outside_raw,
    ):
        root = Path(root_raw)
        member = root / "member"
        host = root / "host"
        outside = Path(outside_raw)
        member.mkdir()
        host.mkdir()

        if os.name == "nt":
            member_command = 'python -c "open(\'member-marker.txt\', \'w\').write(\'member-only\')"'
            outside_path = (outside / "outside-marker.txt").as_posix()
            outside_command = f'python -c "open(r\'{outside_path}\', \'w\').write(\'forbidden\')"'
        else:
            member_command = "printf 'member-only' > member-marker.txt"
            outside_command = "printf 'forbidden' > " + repr(str(outside / "outside-marker.txt"))

        member_result, member_state = fake_case(codex, "tool", member_command, member)
        outside_result, outside_state = fake_case(codex, "tool", outside_command, member)
        context_result, context_state = fake_case(codex, "context", "", member)
        cancellation = cancel_case(codex, member)

        member_output = member_state.requests[1] if len(member_state.requests) > 1 else {}
        outside_output = outside_state.requests[1] if len(outside_state.requests) > 1 else {}
        request_shape = member_state.requests[0] if member_state.requests else {}
        after = codex_state()
        doctor = subprocess.run(
            [codex, "doctor", "--json"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
        try:
            doctor_report = json.loads(doctor.stdout)
        except json.JSONDecodeError:
            doctor_report = {}
        doctor_checks = doctor_report.get("checks", {})
        auth_check = doctor_checks.get("auth.credentials", {})
        config_check = doctor_checks.get("config.load", {})
        normal_provider_and_auth_healthy = (
            auth_check.get("status") == "ok"
            and config_check.get("status") == "ok"
            and config_check.get("details", {}).get("model provider") == "openai"
        )

        return {
            "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
            "codex_version": subprocess.run(
                [codex, "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False
            ).stdout.strip(),
            "config_and_auth_byte_identical": before == after,
            "normal_codex_state_present": {
                "config": before["config"] is not None,
                "auth": before["auth"] is not None,
            },
            "normal_codex_provider_and_auth_healthy": normal_provider_and_auth_healthy,
            "normal_codex_doctor_exit_code": doctor.returncode,
            "request_shape": request_shape,
            "member_tool_round_trip": {
                "client_exit_zero": member_result.returncode == 0,
                "marker_in_member_workspace": (member / "member-marker.txt").read_text() == "member-only"
                if (member / "member-marker.txt").is_file()
                else False,
                "host_workspace_unchanged": not any(host.iterdir()),
                "function_output_returned": member_output.get("has_function_output", False),
                "function_output_reports_success": member_output.get("function_output_reports_success", False),
                "function_output_excerpt": member_output.get("function_output_excerpt", []),
                "queue_keepalive_delay_seconds": 5.0,
            },
            "outside_workspace_denial": {
                "outside_marker_absent": not (outside / "outside-marker.txt").exists(),
                "function_output_returned": outside_output.get("has_function_output", False),
                "function_output_reports_denial": outside_output.get("function_output_reports_denial", False),
                "function_output_excerpt": outside_output.get("function_output_excerpt", []),
                "client_exit_code": outside_result.returncode,
            },
            "context_failure": {
                "client_exit_nonzero": context_result.returncode != 0,
                "error_surfaced": "context length exceeded"
                in (context_result.stdout + context_result.stderr).lower(),
                "request_count": len(context_state.requests),
            },
            "cancellation": cancellation,
        }


def read_sse(payload: bytes) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in payload.decode("utf-8", errors="replace").splitlines():
        if line.startswith("data: "):
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return events


def real_smoke(codex: str, base_url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        base_url.rstrip("/") + "/responses",
        data=json.dumps(
            {
                "model": "localhub-probe",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "input_text",
                                "text": "Call write_marker exactly once with text member-only. Do not answer in prose before the call.",
                            }
                        ],
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "write_marker",
                        "description": "Write a test marker on the caller computer",
                        "parameters": {
                            "type": "object",
                            "properties": {"text": {"type": "string"}},
                            "required": ["text"],
                            "additionalProperties": False,
                        },
                        "strict": True,
                    }
                ],
                "tool_choice": "required",
                "parallel_tool_calls": False,
                "temperature": 0,
                "max_output_tokens": 128,
                "stream": True,
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            events = read_sse(response.read())
        direct_error = None
    except (urllib.error.URLError, TimeoutError) as error:
        events = []
        direct_error = type(error).__name__

    output_items = [event.get("item", {}).get("type") for event in events if event.get("type") == "response.output_item.done"]
    event_types = [event.get("type") for event in events]

    with tempfile.TemporaryDirectory(prefix="localhub-real-model-") as workspace_raw:
        workspace = Path(workspace_raw)
        result = run_codex(
            codex,
            base_url,
            workspace,
            "Use shell_command exactly once to create real-model-marker.txt in the current workspace with the exact contents member-only, then report completion.",
            timeout=180,
        )
        marker = workspace / "real-model-marker.txt"
        codex_event_types: list[str] = []
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event.get("type"), str):
                codex_event_types.append(event["type"])

        return {
            "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
            "codex_version": subprocess.run(
                [codex, "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False
            ).stdout.strip(),
            "direct_responses": {
                "error": direct_error,
                "has_response_completed": "response.completed" in event_types,
                "output_item_types": output_items,
                "function_call_emitted": "function_call" in output_items,
            },
            "codex_real_model": {
                "client_exit_code": result.returncode,
                "marker_created_by_local_tool": marker.is_file() and marker.read_text().strip() == "member-only",
                "event_types": sorted(set(codex_event_types)),
            },
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    fake = subparsers.add_parser("fake-suite")
    fake.add_argument("--codex", default="codex")
    real = subparsers.add_parser("real-smoke")
    real.add_argument("--codex", default="codex")
    real.add_argument("--base-url", required=True)
    args = parser.parse_args()

    result = fake_suite(args.codex) if args.command == "fake-suite" else real_smoke(args.codex, args.base_url)
    print(json.dumps(result, indent=2, sort_keys=True))
    if args.command == "fake-suite":
        assertions = [
            result["config_and_auth_byte_identical"],
            result["request_shape"].get("authorization_header") is False,
            result["request_shape"].get("tool_types") == ["function"],
            "shell_command" in result["request_shape"].get("tool_names", []),
            result["member_tool_round_trip"]["client_exit_zero"],
            result["member_tool_round_trip"]["function_output_reports_success"],
            result["member_tool_round_trip"]["function_output_returned"],
            result["member_tool_round_trip"]["host_workspace_unchanged"],
            result["member_tool_round_trip"]["marker_in_member_workspace"],
            result["outside_workspace_denial"]["outside_marker_absent"],
            result["outside_workspace_denial"]["function_output_returned"],
            result["context_failure"]["client_exit_nonzero"],
            result["context_failure"]["error_surfaced"],
            all(result["cancellation"].values()),
        ]
        return 0 if all(assertions) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
