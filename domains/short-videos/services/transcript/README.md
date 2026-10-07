# Transcript service

`handler.py` is the single implementation of WF-04's transcript contract: it
fetches a YouTube transcript and checks the `x-api-key` header. Two things wrap
it, and neither is a fork of the other.

## AWS Lambda

```bash
./build.sh                  # installs deps from requirements.txt, writes function.zip
```

The dependencies and `function.zip` are gitignored. `build.sh` installs them
into this directory on every build, so the artifact is reproducible from a clean
checkout. It ends by opening the zip and asserting that `handler.py` and
`youtube_transcript_api/` are inside, because a `pip install` that silently
resolved nothing still produces a valid archive.

## Local HTTP server

```bash
python3 local-server.py --api-key local-dev --port 8787
```

Serves the same `handler.handler(event, None)` over HTTP for local WF-04
development. It resolves `handler.py` relative to its own file, so it runs from
any working directory — but it needs the dependencies present, which means
running `./build.sh` (or `pip install -r requirements.txt -t .`) first.

## Tests

```bash
python3 -m pytest domains/short-videos/services/transcript/test_handler.py
```

Needs `pytest` installed; it is not part of `npm test`, which runs only the Node
suites.
