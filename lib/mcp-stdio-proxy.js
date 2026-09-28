#!/usr/bin/env node
'use strict';
/**
 * Stdio MCP server spawned by `claude -p` (via --mcp-config). It is a
 * transparent pipe to the assistant bridge: Claude Code speaks MCP JSON-RPC on
 * this process's stdin/stdout, and we relay it, unchanged, over a unix socket to
 * the bridge, which forwards it across the faceclaw `mcp` channel to the phone's
 * real MCP server (its glasses tool registry). So Claude Code drives the glasses'
 * own tools; the phone stays the source of truth for what those tools are.
 *
 * The bridge tells us which turn we belong to via env (set in the mcp-config):
 *   BRIDGE_SOCK  unix socket path of the bridge's mcp relay
 *   BRIDGE_TURN  opaque per-turn key identifying the ws connection to route to
 */
const net = require('net');

const sockPath = process.env.BRIDGE_SOCK;
const turnKey = process.env.BRIDGE_TURN;
if (!sockPath || !turnKey) {
  process.stderr.write('mcp-stdio-proxy: BRIDGE_SOCK/BRIDGE_TURN not set\n');
  process.exit(1);
}

const sock = net.connect(sockPath, () => {
  // First line identifies the turn; everything after is raw MCP JSON-RPC.
  sock.write(JSON.stringify({ turnKey }) + '\n');
  process.stdin.pipe(sock); // Claude → bridge → phone
  sock.pipe(process.stdout); // phone → bridge → Claude
});

const done = () => process.exit(0);
sock.on('close', done);
sock.on('error', () => process.exit(1));
process.stdin.on('end', done);
