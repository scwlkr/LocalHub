# LocalHub

LocalHub is the product context for private, self-hosted AI access shared by a
host with trusted people.

## Language

**LocalHub**:
A private AI environment operated on hardware controlled by its host and made
available to the Host and trusted Members.
_Avoid_: Model picker, LM Studio wrapper, hosted AI service

**Host**:
The person who operates LocalHub, manages its models and runtime, and controls
who may use it.
_Avoid_: Admin user, server user

**Host Computer**:
The Host-controlled computer that runs LocalHub and provides its inference
capacity.
_Avoid_: Client, cloud server

**Member**:
A trusted person allowed to use LocalHub without managing the Host Computer or
its models.
_Avoid_: Local user, guest, tenant

**Member Label**:
A browser-chosen nickname that helps the Host recognize a Member's queued and
active work. It is not an account, verified identity, or access check.
_Avoid_: Username, login, device identity

**Local Gateway**:
The LAN-only entry point through which Members use LocalHub services exposed by
the Host.
_Avoid_: Public endpoint, internet gateway

**Member Link**:
The friendly LAN address and QR code a Host shares to open Browser Chat, with a
direct Host Computer address as fallback.
_Avoid_: Invite link, public URL

**Browser Chat**:
The Local Gateway interface where a Member talks with a model and deliberately
submits content. Its history belongs to that browser; it is not a way to browse
or control the Member's computer.
_Avoid_: Remote desktop, local file browser

**Attachment**:
A photo or document deliberately submitted through Browser Chat and held by
the Host only long enough to process it.
_Avoid_: Host file, shared upload

**Tool Runner**:
A local program that performs computer and file actions on the same computer
and with the same operating-system permissions as the person who started it.
_Avoid_: Host tool service, remote shell

**Browser Tool**:
A Host-approved capability available in Browser Chat that can use submitted
chat content, Attachments, or the public web but cannot access Host files,
shell commands, or private LAN devices.
_Avoid_: Tool Runner, Host tool

**Web Search**:
A Browser Tool that finds and reads information from the public web without a
paid or metered service.
_Avoid_: Host network search, paid search API

**Context Capacity**:
The maximum amount of material a running model can consider for one response,
set by the Host through its Run Profile.
_Avoid_: Conversation Memory, chat history

**Conversation Memory**:
The amount of the current Browser Chat history a Member chooses to include in
new requests, bounded by the model's Context Capacity.
_Avoid_: Context Capacity, saved memory

**Run Profile**:
A named, reproducible set of controls for how one Model Variant uses the Host
Computer's memory, compute, context capacity, and serving behavior. A Model
Variant may have multiple Run Profiles.
_Avoid_: Fine-tune, training profile

**Profile Test**:
A trial that runs an exact Run Profile without silently changing it and reports
whether it worked, how it performed, and what resources it used.
_Avoid_: Auto-fit, recommended profile

**Profile Result**:
The recorded outcome and measurements from a Profile Test, used to compare Run
Profiles for the same Model Variant.
_Avoid_: Run Profile, estimate

**Shared Model**:
A model the Host has made visible to Members together with the choices and
limits Members may use.
_Avoid_: Installed model, public model

**Installed Model**:
A model available from storage controlled by the Host, whether or not it has
been made available to Members.
_Avoid_: Shared Model, loaded model

**Model Variant**:
A particular downloadable form of a model with a specific size and quality
tradeoff, chosen before the model is run.
_Avoid_: Run Profile, runtime setting

**Model Capability**:
A kind of input or behavior a model can actually support, such as images,
documents, or Browser Tools. LocalHub never substitutes another model when a
selected model lacks a required capability.
_Avoid_: Enabled tool, Run Profile

**Inference Request**:
One submitted request for a model to produce a response.
_Avoid_: Chat, model session

**Request Queue**:
The ordered waiting line for Inference Requests that the Host Computer cannot
serve immediately. A waiting Member can see the request's status and position;
the Host can see its Member Label and cancel it.
_Avoid_: Loading screen, hidden backlog

**Pinned Model**:
A Shared Model the Host has protected from being unloaded or replaced by Member
requests.
_Avoid_: Default model, selected model

**LocalHub Run**:
The active period beginning when the Host explicitly starts LocalHub and ending
only when the Host explicitly stops it. Closing a terminal or browser does not
end a LocalHub Run.
_Avoid_: Terminal session, browser session

**First Run Setup**:
The one-time Host flow that checks the Host Computer, chooses model storage,
starts LocalHub, and opens the dashboard after installation.
_Avoid_: LocalHub Run, model setup

**Model Training**:
Changing a model itself using examples or datasets. Model Training is not part
of LocalHub v1.
_Avoid_: Runtime tuning, Run Profile
