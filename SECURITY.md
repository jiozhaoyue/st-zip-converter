# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Data Privacy & Security Model

`st-zip-converter` is designed with a **privacy-first, client-side only** architecture:

- **100% Local Execution**: All Zip compression, decompression, cross-tavern schema mapping, and archive generation are performed entirely in your local browser runtime (via Web Workers and IndexedDB) or your local SillyTavern server environment.
- **No External Telemetry / No Phone-Home**: This tool does **not** transmit characters, chat histories, secrets, or metadata to any external server or third-party tracking services.
- **Secrets Protection**: When converting archives or performing exports, secrets exclusion / sanitization (safe mode) is natively supported to prevent accidental leaks of API keys.

## Reporting a Vulnerability

If you discover a potential security issue or vulnerability, please report it responsibly:

1. **Do NOT** open a public issue or discussion for zero-day vulnerabilities or security-sensitive bugs.
2. Please report security issues via [GitHub Private Vulnerability Reporting](https://github.com/jiozhaoyue/st-zip-converter/security/advisories/new) on the repository.
3. You will receive an acknowledgment within 48 hours.

Thank you for helping keep the open source community secure!
