# Queue individual inference requests fairly

Each submitted message enters the Request Queue as its own Inference Request;
a chat never reserves a model while its Member is idle. LocalHub finishes an
active response before advancing waiting work and may process a bounded group
for the same loaded model to avoid unnecessary reloads, but scheduling must
prevent any waiting request from being stuck indefinitely.
