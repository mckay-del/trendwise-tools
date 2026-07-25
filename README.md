# Trendwise Tools

Internal reference documents and tools for Trendwise Business Services.

**Canonical source of truth.** This repo is the master copy of Trendwise's context and reference materials. When starting a new AI project session, pull the current version of the relevant file from here rather than relying on cached project knowledge.

## Structure

```
/
├── README.md                          ← this file
├── docs/
│   └── trendwise_context.md           ← master offer architecture, packages, positioning, fields
└── roadmap/
    └── index.html                     ← interactive build roadmap (hosted via Cloudflare Pages)
```

## Key files

| File | Purpose |
|---|---|
| `docs/trendwise_context.md` | Single source of truth: all packages, All-in-One flagship, addons, SaaS feature permissions, client data fields, intake structure, revenue model, tech stack |
| `roadmap/index.html` | Self-contained interactive build roadmap with localStorage progress tracking |

## How to use with Claude

At the start of a new project session, either:
1. Paste the raw contents of `docs/trendwise_context.md`, or
2. Give Claude the raw GitHub URL to fetch directly:
   `https://raw.githubusercontent.com/[USERNAME]/trendwise-tools/main/docs/trendwise_context.md`

## Updating

Edit any file directly in the GitHub web interface, commit, and the change is live everywhere. GitHub is the canonical copy — the Claude project-knowledge copy is a convenience cache that can be refreshed from here anytime.

---

*Trendwise Business Services · K. McKay Larsen EA, Ltd. · Las Vegas, NV*
