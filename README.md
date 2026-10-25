# WAMR - WhatsApp Media Request

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of-conduct-ff69b4.svg)](CODE_OF_CONDUCT.md)

> ⚠️ **WARNING: Unauthorised Clone**
>
> A cloned copy of this project exists at **https://github.com/alokiksoni/wamr**. This repository was not created by the author of WAMR, is not affiliated with this project in any way, and has not been reviewed for safety. **It may contain malware, backdoors, or other malicious code.** Do not use it.
>
> The **only official repository** for WAMR is **https://github.com/techieanant/wamr**.

An open-source, self-hosted WhatsApp bot that enables users to request movies and TV shows through natural conversation. Automatically submits requests to Radarr, Sonarr, or Overseerr.

> **📋 Documentation:**
>
> - [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment with Docker
> - [ENVIRONMENT.md](ENVIRONMENT.md) - Environment variable configuration guide
> - [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guidelines
> - [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - Community guidelines
> - [SECURITY.md](SECURITY.md) - Security policy and reporting
> - [SCREENSHOTS.md](SCREENSHOTS.md) - Application screenshots and interface tour

## 🍴 About This Fork

This is a fork of [techieanant/wamr](https://github.com/techieanant/wamr), tuned for a self-hosted Unraid setup on a home network. Its image is published as **`ghcr.io/zuberousmaximus/wamr:latest`** (x86-64). Note that `docker-compose.prod.yml` still points at the upstream image, so set `image:` to this one to get the changes below.

### Improvements in this fork

**Smarter requests**

- **Request more seasons of a show you already have**: asking for another season of a partially available show now opens the season picker. Seasons already available, downloading or requested are marked, and "all" means all remaining seasons. Previously it stopped at "partially available".
- **Optional LLM intent parsing** (Gemini, OpenAI, Ollama or any OpenAI-compatible endpoint): handles free-form requests, titles that look like commands ("No Country for Old Men"), number titles ("1917") and season ranges ("1-3"). It falls back to the keyword parser on any error and is off by default.
- **Misspelled titles still find a match**: when a search returns nothing, it retries once with the LLM's best guess at the real title ("Coffee with Karan" → "Koffee with Karan"). A wrong guess can't hide a result the original search would have found.
- **Searches that include a year**: "Dune 2021" used to return nothing. A dated search that misses now retries on the bare title and ranks exact-year matches first.

**WhatsApp**

- **Contact allow-list** (optional): only numbers in Contacts get replies, and everyone else is ignored silently. Useful when the linked WhatsApp account is also your personal one.

**Works over plain HTTP on the LAN**

- Fixed a blank white UI at `http://SERVER_IP:9002`, caused by the CSP upgrading assets to https.
- Fixed logins and live updates failing over plain HTTP, caused by the auth cookie always being marked Secure in production.

**Security hardening**

- **Slimmer, non-root image**: 720 MB → 317 MB. It runs as Unraid's `99:100` on Node 22, with no devDependencies, npm or git in the image. Trivy HIGH/CRITICAL findings went from 18 critical / 262 high to 1 / 17.
- **No default secrets**: `JWT_SECRET` and `ENCRYPTION_KEY` must be set; the compose file used to ship public fallback values.
- **Login rate limit can't be bypassed**: a forged `X-Forwarded-For` no longer resets the limit. Only proxies on the host, Docker network or LAN are trusted, configurable with `TRUST_PROXY`.
- **Recovery endpoints are rate-limited**: backup-code regeneration and password reset, which were previously unlimited.
- **Stricter CORS**: dev-origin matching no longer accepts look-alikes such as `localhost.evil.com`.
- **Verified dependencies**: every package in `package-lock.json` is now checked against its integrity hash on install. In-range security updates brought npm audit advisories from 37 to 18; the rest need major upgrades.

**CI**

- CI now runs the typecheck and full test suite on every PR and installs with `npm ci`, so lockfile drift fails the build.

## 🚀 Quick Start

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0
- Docker & Docker Compose (for production deployment)

### Development Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local and set secure values:
# - Generate JWT_SECRET: openssl rand -base64 32
# - Generate ENCRYPTION_KEY: openssl rand -hex 32
# (Optional) Set ADMIN_USERNAME and ADMIN_PASSWORD for auto-seeding

# 3. Setup database
cd backend
npm run db:migrate   # Apply migrations

# 4. Start development (both backend + frontend)
cd ..
npm run dev

# 5. Complete setup wizard
# Access http://localhost:3000 and complete the initial setup
```

**Development Environment:**

- Frontend runs on `http://localhost:3000` (configurable via `.env.local` → `VITE_PORT`)
- Backend runs on `http://localhost:4000` (configurable via `.env.local` → `PORT`)
- Vite dev server automatically proxies `/api` and `/socket.io` to backend

**First Time Setup:**

On first access, you'll be guided through a setup wizard to:
- Create your admin account
- Receive 5 backup codes for account recovery
- Access the dashboard

> **Note:** Use `.env.local` for development and `.env.prod` for Docker/production. See [ENVIRONMENT.md](ENVIRONMENT.md) for details.

## 🎯 Features

### Current Features (v1.2)

- 🧙 **Setup Wizard** - Easy initial setup with guided account creation and backup codes
- 🔐 **Secure Admin Dashboard** - Web-based admin interface with JWT authentication
- 💬 **WhatsApp Integration** - Connect your WhatsApp account via QR code
- 🎬 **Media Request System** - Users can request movies and TV shows via WhatsApp
- 🔄 **Service Integration** - Connect to Radarr, Sonarr, or Overseerr
- 🧠 **Optional LLM Intent Parsing** - Point WAMR at Gemini, OpenAI or a local Ollama model for free-form requests, with automatic fallback to the built-in keyword parser (see [ENVIRONMENT.md](ENVIRONMENT.md#natural-language-intent-parsing-llm))
- 📺 **Per-Season Requests** - Request further seasons of a show that is already partly in your library
- 🙋 **Contact Allow-List** - Optionally reply only to numbers in Contacts
- 📊 **Request Management** - Approve, reject, or auto-approve media requests
- 🔍 **Media Search** - Search across configured media services
- 📝 **Audit Logging** - Complete history of all requests and actions
- 🔑 **Backup Codes** - Account recovery with 5 single-use backup codes
- 🔒 **Security First** - Encrypted API keys, hashed credentials, rate limiting
- 🐳 **Docker Ready** - Easy deployment with Docker Compose
- 🎨 **Modern UI** - Beautiful, responsive admin dashboard with Shadcn UI

## 🎯 Use Cases

- **Home Media Server**: Manage family media requests
- **Private Media Libraries**: Controlled access to media automation
- **Community Media Sharing**: Moderate media requests from community members
- **Personal Assistant**: Natural language interface to media services

## 📂 Project Structure

```
wamr/
├── backend/                # Node.js/Express API
│   ├── src/
│   │   ├── api/           # Routes, controllers, middleware, validators
│   │   ├── config/        # Environment, logger
│   │   ├── db/            # Database client, schema
│   │   ├── services/      # Business logic (auth, encryption, integrations, WhatsApp)
│   │   ├── utils/         # Error codes, templates, helpers
│   │   ├── types/         # TypeScript types
│   │   └── index.ts       # App entry point
│   ├── tests/             # Unit, integration, E2E tests
│   ├── drizzle/           # Database migrations
│   └── data/              # SQLite database file
│
└── frontend/              # React/Vite SPA
    ├── src/
    │   ├── components/    # UI components (shadcn/ui)
    │   ├── pages/         # Page components
    │   ├── hooks/         # Custom React hooks
    │   ├── services/      # API client, Socket.IO
    │   ├── lib/           # Utils, query client
    │   └── types/         # TypeScript types
    └── tests/             # Component and E2E tests
```

## 🛠️ Development Commands

All commands use Turborepo for efficient task orchestration. Run from the project root:

### Development

```bash
npm run dev              # Start both backend + frontend (parallel)
npm run backend:dev      # Backend only
npm run frontend:dev     # Frontend only
```

### Building

```bash
npm run build            # Build everything (with smart caching)
npm run backend:build    # Build backend only
npm run frontend:build   # Build frontend only
```

### Testing & Quality - TODO

```bash
npm run test             # Run all tests
npm run lint             # Lint code
npm run format           # Format code with Prettier
npm run format:check     # Check formatting without changes
```

### Database (run from backend/)

```bash
cd backend
npm run db:generate      # Generate migrations from schema changes
npm run db:migrate       # Apply migrations to database
npm run db:studio        # Open Drizzle Studio (database GUI)
npm run db:seed          # Seed database with admin user (optional)
```

> **Note:** The setup wizard handles initial admin creation. Database seeding is only needed if you set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in environment variables.

### Docker (Production)

```bash
npm run docker:build     # Build Docker images
npm run docker:up        # Start containers in detached mode
npm run docker:down      # Stop and remove containers
npm run docker:logs      # View container logs
npm run docker:restart   # Restart all services
```

> **💡 Tip:** For detailed Docker deployment options, see [DEPLOYMENT.md](DEPLOYMENT.md)

### Cleanup

```bash
npm run clean            # Remove dist/, node_modules, .turbo cache
```

## 🔐 Security

See [SECURITY.md](SECURITY.md) for our security policy and vulnerability reporting.

**Key Security Features:**

- Encrypted API keys (AES-256-GCM)
- Hashed passwords (bcrypt)
- Hashed phone numbers (SHA-256)
- JWT authentication
- Rate limiting on all endpoints, with tighter limits on login and account recovery
- Client IPs taken only from trusted (private-network) proxies, so rate limits can't be bypassed with a forged `X-Forwarded-For`
- No default secrets: `JWT_SECRET` and `ENCRYPTION_KEY` must be provided
- Container runs as a non-root user (`99:100`)
- Automatic sensitive data redaction in logs

## 📝 Database

### Schema

- **admin_users**: Admin credentials
- **setup_status**: Tracks if initial setup is complete
- **backup_codes**: Single-use recovery codes for admin accounts
- **whatsapp_connections**: WhatsApp connection status
- **conversation_sessions**: Active multi-turn conversations
- **media_service_configurations**: Radarr/Sonarr/Overseerr configs
- **request_history**: Audit log of all requests
- **settings**: Application configuration settings
- **contacts**: Phone number contacts with encrypted data

### Migrations

See [Database Commands](#database-run-from-backend) above for migration workflow.

## 🧪 Testing

**Status**: ✅ Active - 850 tests passing

**Current Coverage:**

- **Backend**: 843 tests covering controllers, services, repositories, and middleware
- **Frontend**: 7 component and utility tests
- **CI/CD**: Automated testing with `npm run ci`

**Run Tests:**

```bash
npm ci                    # Install exactly what package-lock.json pins
npm test                  # Run all tests
npm test -w backend       # Backend tests only
npm test -w frontend      # Frontend tests only
```

**Test Infrastructure:**

- Vitest for unit testing
- React Testing Library for component tests
- Mocked database and external services
- Comprehensive coverage of authentication, API endpoints, and business logic

## 🐳 Docker Deployment

**Quick Start:**

```bash
# Generate your own secrets (required; there are no defaults)
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -hex 32)" > .env.prod

# Pull and start
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# Access: http://localhost:9002
# Complete the setup wizard to create your admin account
```

Keep `.env.prod` out of git, and keep `ENCRYPTION_KEY` once data exists: stored API keys and phone numbers are encrypted with it.

**Customize Settings (Optional):** copy `.env.example` to `.env.prod`, add your secrets and any overrides, and start with the same command.

**Upgrading from a version that shipped default secrets:** if you never set your own, the container has been using the old defaults. To keep the existing data readable, put those exact values in `.env.prod` (or generate new ones on a fresh install).

**Access:**

- Local: `http://localhost:9002`
- Network: `http://YOUR_SERVER_IP:9002`
- Reverse Proxy: `https://wamr.yourdomain.com`

📖 **See [DEPLOYMENT.md](DEPLOYMENT.md) for complete deployment instructions, configuration options, and troubleshooting.**

## 🤝 Contributing

We love contributions! Please read our [Contributing Guide](CONTRIBUTING.md) to learn about our development process, how to propose bugfixes and improvements, and how to build and test your changes.

### Quick Start for Contributors

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Commit using conventional commits (`git commit -m 'feat: add amazing feature'`)
5. Push to your branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

Check out [good first issues](https://github.com/techieanant/wamr/labels/good%20first%20issue) to get started!

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

This means you are free to use, modify, and distribute this software, even for commercial purposes, as long as you include the original copyright notice and license.

## 🙏 Acknowledgments

- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web API
- [Radarr](https://radarr.video/) - Movie management
- [Sonarr](https://sonarr.tv/) - TV series management
- [Overseerr](https://overseerr.dev/) - Request management system
- [Shadcn UI](https://ui.shadcn.com/) - Beautiful UI components

## � Support

- 📖 [Documentation](README.md)
- 🐛 [Issue Tracker](https://github.com/techieanant/wamr/issues)
- 💬 [Discussions](https://github.com/techieanant/wamr/discussions)
- 🔒 [Security Policy](SECURITY.md)

## 🗺️ Roadmap

See our [GitHub Projects](https://github.com/techieanant/wamr/projects) for upcoming features and releases.

## ⭐ Star History

If you find this project useful, please consider giving it a star! It helps others discover the project.

---

**Made with ❤️ by Anant**
