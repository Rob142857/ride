# Ma'atara Protocol — Workspace Instructions

## Project Overview

Ma'atara is a **post-quantum content provenance platform** — patent-pending architecture for hardware-rooted data sovereignty. Monorepo with TypeScript Cloudflare Workers, Rust WASM cryptography, and Solidity smart contracts.

**Key resources**: [Whitepaper](../docs/whitepaper/Maatara_Whitepaper_Full.md) · [Build Instructions](../BUILD_INSTRUCTIONS.md) · [Roadmap](../ROADMAP.md) · [Patent Spec](../AU_PATENT_SPECIFICATION_MAATARA.md)

## Architecture

| Component                | Path               | Purpose                                               |
| ------------------------ | ------------------ | ----------------------------------------------------- |
| `core-worker/`           | Main API           | Auth, session, encryption, health, docs               |
| `aegis-worker/`          | Provenance         | Multi-layer fingerprint verification at edge          |
| `edge-key-fabric/`       | Key mgmt           | Distributed PQC key lifecycle                         |
| `maatara-auth-worker/`   | Auth               | Authentication & session layer                        |
| `ai-consent-worker/`     | Consent            | AI training consent governance (IETF AI-Pref)         |
| `packages/pqc-toolkit/`  | Crypto lib         | Post-quantum crypto primitives (TS)                   |
| `packages/worker-utils/` | Shared             | Types, helpers shared across workers                  |
| `rust/`                  | 14-crate workspace | Core crypto compiled to WASM (Dilithium, BLAKE3, FHE) |
| `contracts/`             | Solidity           | AnchorRegistry.sol + MaataraProvenance.sol (planned)  |
| `pressure/`              | Canonical docs     | Versioned specs served via pressure-manifest.ts       |
| `.ai/memory/`            | Project brain      | architecture.md, progress.md, activeContext.md        |

## Tech Stack

- **Runtime**: Cloudflare Workers (Wrangler 4.x), ES2022, ESNext modules
- **Build**: esbuild 0.25, WASM via `cargo build --target wasm32-unknown-unknown` + wasm-bindgen
- **Test**: Vitest 3.x (`npm run test`, per-package `npm run test:core` etc.)
- **Lint**: ESLint 9 + @typescript-eslint + Prettier 3.4 (`npm run lint`, `npm run format`)
- **Solidity**: Foundry (solc 0.8.20, Paris EVM, optimizer 200 runs)
- **Rust**: Cargo workspace, 14 crates, WASM target

## Build & Deploy Commands

```bash
npm run build              # All packages in sequence (toolkit → core → ekf → aegis)
npm run test               # All vitest suites
npm run lint:fix           # ESLint with --fix
npm run format             # Prettier write
cd core-worker && wrangler deploy --env production   # Per-worker deploy
```

## Code Conventions

- **TypeScript**: Strict mode, ES2022 target, `@cloudflare/workers-types` for Worker APIs
- **No `any`**: Prefer explicit types; `any` is a lint warning
- **Unused vars**: Prefix with `_` if intentionally unused
- **Imports**: ESNext module syntax, no CommonJS require()
- **WASM integration**: Import `.wasm` files directly; esbuild copies them to output
- **Rust**: Follow `cargo clippy` recommendations; all crates target `wasm32-unknown-unknown`
- **Solidity**: Foundry conventions, NatSpec documentation on public functions

## Cryptographic Conventions (CRITICAL)

- **Default signatures**: ML-DSA / Dilithium2 (NIST FIPS 204) — post-quantum
- **Default hashing**: SHA3-384 (FIPS 202) primary, BLAKE3 secondary
- **SHA2 policy**: Treat SHA-2 / SHA-256 references in active code, docs, prompts, manifests, or generated artifacts as defects. Replace them with SHA3-384 immediately unless the code path is explicitly labeled as legacy-compatibility under active migration.
- **Key encapsulation**: ML-KEM / Kyber768 (NIST FIPS 203) for hybrid transport
- **Never use**: RSA, ECDSA, or classical-only schemes in new code
- **All signing keys**: Must be hardware-bound or attested where possible
- **Perceptual hashing**: PDQ for images, TMK+PDQF for video

## Agent Review Rules

- Agents must flag SHA-2 / SHA-256 mentions as findings during review, patch planning, and documentation sweeps.
- If a SHA-2 reference cannot be removed safely within the current task, agents must call it out explicitly as migration debt instead of restating it as current architecture.

## Security Principles

- Zero Trust: never trust, always verify — every request is hostile until proven
- No secrets in code or environment variables at rest — use Wrangler secrets or KV
- All user input validated at system boundaries
- No private key material leaves hardware boundary
- PQC by default — classical only for backward-compat bridges

## MCP Servers (Model Context Protocol)

This workspace has **8 MCP servers** configured in `.vscode/mcp.json` for AI-powered development:

| Server                  | Type         | Purpose                                               |
| ----------------------- | ------------ | ----------------------------------------------------- |
| **GitHub**              | Remote/OAuth | Repo management, issues, PRs, CI/CD, code security    |
| **Sentry**              | Remote/OAuth | Error monitoring, issue triage, Seer AI analysis      |
| **Stripe**              | Remote/OAuth | Payment integration, commercial licensing             |
| **Figma**               | Remote/OAuth | Design-to-code, component specs, design tokens        |
| **Svelte**              | Remote       | Svelte 5 docs, code analysis, best practices          |
| **AWS**                 | Remote       | AWS docs, CDK, infrastructure, cost estimation        |
| **Sequential Thinking** | Local/npx    | Structured reasoning scratchpad for complex refactors |
| **Atlassian**           | Local/uvx    | Jira issues, Confluence pages, project management     |

When performing tasks, **prefer MCP tools over manual lookups** — e.g. use GitHub MCP to check CI status rather than guessing, use Sentry MCP to find real errors rather than speculating.

See [MCP_INTEGRATION_GUIDE.md](../docs/guides/MCP_INTEGRATION_GUIDE.md) for full setup and usage details.

## Project Brain (Memory Bank)

The `.ai/memory/` directory contains living context documents that persist across sessions:

| File               | Purpose                                                | Update Frequency          |
| ------------------ | ------------------------------------------------------ | ------------------------- |
| `architecture.md`  | The "Why" — system design, monorepo map, key decisions | When architecture changes |
| `progress.md`      | Active work streams, recently completed, blockers      | Each session              |
| `activeContext.md` | Current task state, files modified, open questions     | Every session (by agent)  |

**Convention**: At the start of a new session, read `.ai/memory/progress.md` to understand current state. At the end of a session, update `activeContext.md` with what was done.

## Documentation Structure

All documentation lives under `docs/` in organised subdirectories:

| Directory          | Contents                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `docs/specs/`      | Technical specifications (Aegis, Parable, Wallet, Atelier, etc.)  |
| `docs/patent/`     | Patent applications, IP strategy, commercial licensing            |
| `docs/research/`   | Competitive analysis, research conversations, performance reports |
| `docs/whitepaper/` | Whitepaper versions, vision, plain language guide                 |
| `docs/dev/`        | Developer guides (auth, provenance, encryption, cross-chain)      |
| `docs/guides/`     | Setup guides (MCP, reCAPTCHA, architecture notes)                 |
| `docs/planning/`   | Execution plans, phase planning                                   |
| `docs/export/`     | Binary exports (docx, pdf, m4a) — **excluded from search**        |

Only 7 essential MD files remain at root: README, BUILD_INSTRUCTIONS, BUILD_STATUS, CHANGELOG, CONTEXT, ROADMAP, AU_PATENT_SPECIFICATION_MAATARA.

## Intellectual Property

This codebase is **PATENT PENDING**. When generating code or documentation:

- Include `PATENT PENDING` notices where contextually appropriate
- Do not simplify or omit novel algorithmic steps that constitute claims
- Preserve commitment-reveal, multi-layer fingerprint, and hardware attestation flows exactly as specified
