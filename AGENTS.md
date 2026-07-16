# AGENTS.md

## Project identity

Starlight Bridge is a generic ACP-to-OpenAI compatibility bridge with MCP support. Preserve that identity at all costs.

It must remain useful with arbitrary ACP agents, OpenAI-compatible clients, MCP servers, models, and deployment environments. A feature for one device, vendor, agent, or application must never redefine the core architecture.

## Architectural rules

- Keep the core protocol layers vendor-neutral: OpenAI request/response translation, ACP session management, routing, authentication, streaming, and MCP transport.
- Implement product-specific behavior as an optional integration or adapter behind a generic interface.
- Integration modules must be removable without changing core protocol behavior.
- Do not hard-code device hostnames, private URLs, credentials, model names, provider names, tool names, sentinel values, or product assumptions in generic core modules.
- Put integration-specific configuration under a clearly named optional configuration section. Default installations must not require that integration.
- Prefer capability discovery and configuration over special cases.
- Keep MCP tools generic whenever possible. If a tool is inherently product-specific, isolate its registration and implementation in that product's adapter.
- Never make a product-specific workaround the default behavior for unrelated users.
- Protocol extensions must degrade cleanly when the corresponding integration is disabled or unavailable.
- Tests for the generic bridge must run without access to any specific device or external private service.

## Change review checklist

Before accepting a change, ask:

1. Does this belong in the generic bridge or in an integration adapter?
2. Would the bridge still build, start, and pass tests if the integration were removed?
3. Is any vendor or device assumption leaking into routing, ACP, OpenAI, or MCP transport code?
4. Can the behavior be expressed as a capability, hook, adapter, or configuration option instead of a hard-coded branch?
5. Does the default remain sensible for users who have never heard of the integration?

When convenience conflicts with generic architecture, preserve the generic architecture. A little adapter boilerplate is cheaper than turning Starlight into one device's unusually elaborate extension cord.
