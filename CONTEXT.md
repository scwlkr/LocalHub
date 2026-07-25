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

**Local Gateway**:
The LAN-only entry point through which Members use LocalHub services exposed by
the Host.
_Avoid_: Public endpoint, internet gateway

**Run Profile**:
A saved, reproducible set of controls for how a model uses the Host Computer's
memory, compute, context capacity, and serving behavior.
_Avoid_: Fine-tune, training profile

**LocalHub Run**:
The active period beginning when the Host explicitly starts LocalHub and ending
only when the Host explicitly stops it. Closing a terminal or browser does not
end a LocalHub Run.
_Avoid_: Terminal session, browser session

**Model Training**:
Changing a model itself using examples or datasets. Model Training is not part
of LocalHub v1.
_Avoid_: Runtime tuning, Run Profile
