# Use llama.cpp as the core inference engine

LocalHub will directly manage llama.cpp processes, model files, and Run
Profiles because the Host needs precise control over how models run without
depending on another model manager. The existing LM Studio integration is not
part of the target core architecture; compatibility may be reconsidered later.
