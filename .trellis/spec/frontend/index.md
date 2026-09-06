# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | In-app plugin architecture, esbuild targets, and bundle distribution | Ready |
| [Component Guidelines](./component-guidelines.md) | Vanilla DOM injection, namespace isolation, CSS scoping mandate, and host detection protocol | Ready |
| [Hook Guidelines](./hook-guidelines.md) | Host lifecycle integration, CSRF tokens, and backup API hooks | Ready |
| [State Management](./state-management.md) | Ephemeral UI state, in-memory blob lifecycle, and URL revocation | Ready |
| [Quality Guidelines](./quality-guidelines.md) | Bundle budget (<200KiB), engine parity, and headless smoke testing | Ready |
| [Type Safety](./type-safety.md) | JSDoc contracts, runtime target guards, and manifest schema validation | Ready |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
