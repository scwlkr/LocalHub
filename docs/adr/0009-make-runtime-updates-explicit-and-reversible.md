# Make runtime updates explicit and reversible

LocalHub and its bundled llama.cpp version never update automatically. The
dashboard may report an available update, but only the Host can install it, and
the previous working version remains available for rollback because runtime
changes may alter model compatibility, behavior, or performance.
