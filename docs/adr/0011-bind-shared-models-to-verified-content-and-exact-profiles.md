# Bind Shared Models to verified content and exact profiles

LocalHub identifies each Installed Model by verified content rather than its
filename, source, or path, and publishes a Shared Model only through one exact,
currently passing Run Profile revision. Renames and verified storage moves
preserve identity; changed model bytes, runtime, or profile controls make prior
proof stale, and missing or failed targets become unavailable instead of
silently selecting another variant or profile. This trades automatic fallback
for reproducible Host control and truthful Member behavior.
