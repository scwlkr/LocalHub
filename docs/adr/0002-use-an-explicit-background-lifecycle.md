# Use an explicit background lifecycle

Running `lh` starts LocalHub in the background, opens the Host dashboard, and
returns the terminal prompt. LocalHub continues serving the Host and Members
until the Host stops it from the dashboard or with `lh stop`; closing the
launching terminal or browser does not stop it, and LocalHub does not start
itself without the Host.
