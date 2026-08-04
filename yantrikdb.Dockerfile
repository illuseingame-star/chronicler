# YantrikDB MCP server image. Pre-installs the package + its dependencies at
# build time so containers start in seconds, not minutes. Uses the CPU-only
# torch wheel to avoid downloading 400+MB of CUDA libraries on machines that
# can't use them (Apple Silicon, typical laptops).

FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    YANTRIKDB_DB_PATH=/data/memory.db

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pinned deliberately. An unpinned `pip install yantrikdb-mcp[onnx]` silently
# drifts on every rebuild — and on 2026-08-04 that drift took the stack down:
# the `mcp` SDK released 2.0.0, which removed `mcp.server.fastmcp`, while
# yantrikdb-mcp still imports that path. Result: ModuleNotFoundError in a
# crash-loop, from a Dockerfile nobody had edited.
#
# yantrikdb's own v0.10.0 release notes name this exact trap:
#   "version pins fail (the version doesn't move), signature checks fail
#    (behavior moves without them)... Pin immutable refs, probe features
#    not versions, and declare unsupported capabilities at runtime instead
#    of silently degrading."
#
# So: pin the floor AND the ceiling on both packages, and let
# scripts/probe-mcp-tools.ts assert capabilities at runtime rather than
# trusting a version string.
#
# MCP_VERSION — must stay <2 until yantrikdb-mcp migrates off
#   mcp.server.fastmcp (removed in the 2.0.0 SDK).
# YANTRIKDB_MCP_VERSION — the [onnx] extra is required for the 384-dim
#   sentence-transformers embedder that existing chronicler DBs were created
#   against. Without it, recall + skill calls error with "ONNX embedder
#   requested but optional deps not installed", and the slim install falls
#   back to a 64-dim bundled embedder that silently recalls nothing from a
#   384-dim volume.
ARG MCP_VERSION=">=1.9,<2"
ARG YANTRIKDB_MCP_VERSION="==0.10.0"

RUN pip install --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install "mcp${MCP_VERSION}" "yantrikdb-mcp[onnx]${YANTRIKDB_MCP_VERSION}" \
    && python -c "from mcp.server.fastmcp import FastMCP; import yantrikdb_mcp; print('import gate OK')"

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8420

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD python -c "import socket; s=socket.create_connection(('localhost', 8420), 3); s.close()" || exit 1

CMD ["yantrikdb-mcp", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8420"]
