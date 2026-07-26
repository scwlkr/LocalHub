# Separate Host and Member tool authority

LocalHub v1 follows an Odysseus-shaped trust split: the loopback-only Host may
use unsandboxed Host Tools with LocalHub's process permissions and accepts that
machine-level risk, while Members receive only Host-approved Tool Groups that
passed the selected Shared Model's Profile Test. This refines the local-tool
boundary in ADR 0003 without widening Member authority: Member tools cannot
reach Host files, shell, secrets, private LAN devices, or admin controls; their
browser state is temporary, external changes require Member approval, and paid
or metered actions are always blocked. Public-web tooling uses only the pinned,
loopback-only SearXNG path, with no provider fallback.
