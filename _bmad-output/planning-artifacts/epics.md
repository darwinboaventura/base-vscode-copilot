---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: ["product-brief.md", "architecture.md", "ux-design-specification.md"]
workflow_status: complete
workflow_completed: 2026-02-18
---

# stackcode - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for stackcode, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

| ID | Requirement |
|----|-------------|
| **FR1** | Autocomplete Inline - Sugestões de código em tempo real como ghost text |
| **FR2** | Copilot Chat - Interface de chat idêntica ao Copilot Chat com comandos (/explain, /fix, /generate, /test) |
| **FR3** | Inline Suggestions - Ghost text rendering com accept (Tab) e dismiss (Escape) |
| **FR4** | Settings - Configurações de comportamento e privacidade |
| **FR5** | Authentication - Integração com Stackspot AI (login/logout, token management) |

### NonFunctional Requirements

| ID | Requirement |
|----|-------------|
| **NFR1** | Zero Data Leakage - Arquitetura DEVE garantir 0 requisições HTTP/websocket para servidores não autorizados |
| **NFR2** | Performance - Latência de sugestão < 200ms, taxa de aceitação > 50% |
| **NFR3** | Compatibilidade - 100% de paridade com VS Code upstream |
| **NFR4** | Conformidade Legal - LGPD/GDPR compliance |
| **NFR5** | Acessibilidade - WCAG 2.1 compliance |

### Additional Requirements

#### From Architecture:
- **Starter Template**: Fork do VS Code (iniciar com clone do repositório Microsoft)
- **Network Security**: Modificação no HTTP Agent para bloquear requisições não autorizadas (*.stackspot.com permitido)
- **Stackspot AI Integration**: SSE Streaming para chat e autocomplete
- **Token Storage**: VS Code Keychain (usar keytar)
- **Context Builder**: Workspace Context com Client-Side History
- **Extension Architecture**: Internal Extension em `./extensions/stackcode-chat/`

#### From UX:
- **Indicador de Privacidade**: Barra de status mostrando status de conexão Stackspot AI
- **Onboarding**: Fluxo de configuração do Stackspot AI integrado nas settings
- **Design System**: Herda sistema de design nativo do VS Code
- **Cores**: Mantém identidade visual do Copilot (roxo) + indicadores de privacidade

### FR Coverage Map

| FR | Epic Coverage |
|----|---------------|
| FR1 (Autocomplete Inline) | Epic 3: Autocomplete Feature |
| FR2 (Copilot Chat) | Epic 4: Chat Feature |
| FR3 (Inline Suggestions) | Epic 3: Autocomplete Feature |
| FR4 (Settings) | Epic 2: Configuration System & Authentication |
| FR5 (Authentication) | Epic 2: Configuration System & Authentication |
| NFR1 (Zero Data Leakage) | Epic 1: Project Setup & Network Security |
| NFR2 (Performance) | Epic 3: Autocomplete Feature |
| NFR3 (Compatibilidade) | Epic 1: Project Setup & Network Security |
| NFR4 (LGPD/GDPR) | Epic 2: Configuration System & Authentication |
| NFR5 (WCAG 2.1) | Epic 4: Chat Feature |

## Epic List

### Epic 1: Project Setup & Network Security
**Objective:** Set up the VS Code fork and implement network security to ensure zero data leakage to unauthorized servers.
**FRs covered:** NFR1, NFR3
**Status:** 🟡 In Progress

### Epic 2: Configuration System & Authentication
**Objective:** Implement VS Code settings integration and OAuth2 authentication with Stackspot AI.
**FRs covered:** FR4, FR5, NFR4
**Status:** 🔴 Not Started

### Epic 3: Autocomplete Feature
**Objective:** Implement inline autocomplete with ghost text rendering, matching the Copilot experience exactly.
**FRs covered:** FR1, FR3, NFR2
**Status:** 🔴 Not Started

### Epic 4: Chat Feature
**Objective:** Implement the Copilot Chat interface with all commands and contextual understanding.
**FRs covered:** FR2, NFR5
**Status:** 🔴 Not Started

---

## Epic 1: Project Setup & Network Security

### Epic Goal

Set up the VS Code fork and implement network security to ensure zero data leakage to unauthorized servers.

### Stories

#### Story 1.1: Initialize VS Code Fork ✅ COMPLETED

As a developer,
I want to have a complete fork of VS Code as the project base,
So that I can build upon a stable, 100% compatible codebase.

**Acceptance Criteria:**

**Given** I need to create the stackcode project,
**When** I clone the VS Code repository and set up remotes,
**Then** A complete VS Code fork should exist with upstream remote configured
**And** The project should compile successfully

**Status:** ✅ COMPLETED
**Location:** `/Users/darwin/Desktop/stackcode-stackspot-extension/stackcode`

---

#### Story 1.2: Implement HTTP Agent Blocking

As a security architect,
I want to block all HTTP/WebSocket requests to unauthorized servers,
So that zero data leakage is guaranteed (NFR1).

**Acceptance Criteria:**

**Given** The VS Code fork is set up,
**When** Any HTTP or WebSocket request is made from the application,
**Then** Requests to non-authorized domains should be blocked
**And** Only requests to *.stackspot.com should be allowed
**And** All blocked requests should be logged for audit

**Given** A request is made to microsoft.com,
**When** The HTTP Agent intercepts the request,
**Then** The request should be blocked with a clear error
**And** An audit log entry should be created

---

#### Story 1.3: Configure Allowed Domains

As a security architect,
I want to configure which domains are allowed,
So that the security team can manage approved endpoints.

**Acceptance Criteria:**

**Given** The network security is implemented,
**When** A user configures allowed domains in settings,
**Then** Only the configured domains should be accessible
**And** Default allowed domains should be: *.stackspot.com, idm.stackspot.com

---

## Epic 2: Configuration System & Authentication

### Epic Goal

Implement the VS Code settings integration and OAuth2 authentication with Stackspot AI.

### Stories

#### Story 2.1: Adapt stackcode-chat Extension for Stackspot AI 🔄 IN PROGRESS

As a developer,
I want to adapt the cloned vscode-copilot-chat extension to work with Stackspot AI,
So that the chat functionality can use Stackspot AI as the backend instead of Copilot.

**Acceptance Criteria:**

**Given** The vscode-copilot-chat has been cloned,
**When** I modify the extension to work with Stackspot AI,
**Then** The extension should communicate with Stackspot AI API endpoints
**And** Should use OAuth2 authentication with Stackspot IDM
**And** Should handle SSE streaming for responses
**And** Should maintain the Copilot Chat UI/UX

**Current State:**
- Extension cloned from vscode-copilot-chat
- Location: `/Users/darwin/Desktop/stackcode-stackspot-extension/stackcode/extensions/stackcode-chat`
- **No modifications made yet** - needs to replace Copilot backend with Stackspot AI

**Required Modifications:**
- Replace API endpoints from Copilot to Stackspot AI
- Implement OAuth2 flow with Stackspot IDM
- Adapt SSE handling for Stackspot AI responses
- Update authentication to use Stackspot credentials

---

#### Story 2.2: Implement VS Code Settings

As a user,
I want to configure stackcode settings,
So that I can customize the behavior.

**Acceptance Criteria:**

**Given** The extension is created,
**When** The user opens VS Code settings,
**Then** stackcode settings should be available in the settings UI
**And** Should include: clientId, clientKey, realm, agentId, apiEndpoint, idmEndpoint, allowedDomains, enableAutocomplete

---

#### Story 2.3: Implement OAuth2 Authentication

As a user,
I want to authenticate with Stackspot AI,
So that I can use the AI features.

**Acceptance Criteria:**

**Given** The settings are configured,
**When** The user provides clientId, clientKey, and realm,
**Then** OAuth2 token request should be made to Stackspot IDM
**And** Token should be stored securely in VS Code Keychain
**And** Token should refresh automatically before expiration

**Given** The token has expired,
**When** A request is made to the API,
**Then** The token should be refreshed automatically
**And** The user should not need to re-authenticate

---

#### Story 2.4: Implement Token Management

As a security system,
I want to securely manage authentication tokens,
So that user credentials are protected.

**Acceptance Criteria:**

**Given** Authentication is successful,
**When** Tokens are stored,
**Then** Tokens should be stored in OS keychain (not in plain text)
**And** On logout, tokens should be securely deleted

---

## Epic 3: Autocomplete Feature

### Epic Goal

Implement inline autocomplete with ghost text rendering, matching the Copilot experience exactly.

### Stories

#### Story 3.1: Implement Stackspot AI API Client

As a developer,
I want to have a client to communicate with Stackspot AI,
So that I can get AI suggestions.

**Acceptance Criteria:**

**Given** Authentication is working,
**When** I need to get AI suggestions,
**Then** The API client should make requests to the Stackspot AI endpoint
**And** Should support SSE streaming for real-time responses
**And** Should handle errors gracefully

---

#### Story 3.2: Implement Context Builder

As an AI system,
I want to build the proper context for each request,
So that the AI understands the code.

**Acceptance Criteria:**

**Given** A user is typing code,
**When** A suggestion is requested,
**Then** The context should include: current file content, cursor position, selection, workspace structure, related files
**And** Context should be formatted properly for the API

**Given** Chat history is needed,
**When** Building context for chat,
**Then** History should be maintained client-side
**And** Full context should be sent with each request (not using server conversation_id)

---

#### Story 3.3: Implement Inline Completion Provider

As a user,
I want to see AI suggestions as I type,
So that I can write code faster.

**Acceptance Criteria:**

**Given** The user is typing code,
**When** After 2-3 characters are typed,
**Then** Suggestions should appear as ghost text
**And** Latency should be < 200ms (NFR2)

**Given** A suggestion is displayed,
**When** The user presses Tab,
**Then** The suggestion should be accepted
**And** The ghost text should become real code

**Given** A suggestion is displayed,
**When** The user presses Escape,
**Then** The suggestion should be dismissed

---

#### Story 3.4: Implement Ghost Text Renderer

As a user,
I want to see suggestions styled like Copilot,
So that the experience is familiar.

**Acceptance Criteria:**

**Given** A suggestion is available,
**When** It is rendered,
**Then** Ghost text should appear in gray/faded style
**And** Should follow VS Code theme (dark/light)
**And** Should match Copilot visual style

---

#### Story 3.5: Implement Suggestion Manager

As a user,
I want to manage multiple suggestions,
So that I can choose the best option.

**Acceptance Criteria:**

**Given** Multiple suggestions are available,
**When** The user navigates suggestions,
**Then** Multiple suggestions should be displayed
**And** User should be able to cycle through options

---

## Epic 4: Chat Feature

### Epic Goal

Implement the Copilot Chat interface with all commands and contextual understanding.

### Stories

#### Story 4.1: Create Chat Webview

As a user,
I want to have a chat interface,
So that I can ask questions about my code.

**Acceptance Criteria:**

**Given** The extension is loaded,
**When** The user opens the chat panel,
**Then** A chat webview should appear in the sidebar
**And** Should match Copilot Chat visual style
**And** Should be resizable

---

#### Story 4.2: Implement Chat Context

As a chat system,
I want to understand the current code context,
So that answers are relevant.

**Acceptance Criteria:**

**Given** A chat message is sent,
**When** Building the request,
**Then** Current file content should be included
**And** Selected code should be included
**And** Cursor position should be included

---

#### Story 4.3: Implement /explain Command

As a user,
I want to understand what code does,
So that I can learn from it.

**Acceptance Criteria:**

**Given** Selected code exists,
**When** User types /explain,
**Then** AI should explain what the code does
**And** Explanation should be clear and educational

---

#### Story 4.4: Implement /fix Command

As a user,
I want to fix problems in my code,
So that errors are resolved.

**Acceptance Criteria:**

**Given** Code with errors exists,
**When** User types /fix,
**Then** AI should suggest fixes for the errors
**And** Fixes should be applied or easy to apply

---

#### Story 4.5: Implement /generate Command

As a user,
I want to generate new code,
So that I can speed up development.

**Acceptance Criteria:**

**Given** User describes what they want,
**When** User types /generate,
**Then** AI should generate appropriate code
**And** Generated code should match the project style

---

#### Story 4.6: Implement /test Command

As a user,
I want to generate tests,
So that I can verify my code.

**Acceptance Criteria:**

**Given** Code to test exists,
**When** User types /test,
**Then** AI should generate unit tests
**And** Tests should follow project testing conventions

---

#### Story 4.7: Implement Privacy Indicator

As a user,
I want to see my privacy status,
So that I know my data is secure.

**Acceptance Criteria:**

**Given** The application is running,
**When** Viewing the status bar,
**Then** A privacy indicator should show connection status
**And** Green = connected to Stackspot AI
**And** Gray = not connected
**And** Red = error

**Given** Hovering over the indicator,
**When** The user wants more info,
**Then** A tooltip should show detailed status

---

#### Story 4.8: Implement Onboarding Flow

As a new user,
I want to be guided through setup,
So that I can start using the tool quickly.

**Acceptance Criteria:**

**Given** First time using stackcode,
**When** Opening the editor,
**Then** A setup prompt should suggest configuring Stackspot AI
**And** Configuration should be simple and guided
**And** After setup, autocomplete should work immediately

---

## Summary

### Completed Stories
| Epic | Story | Status |
|------|-------|--------|
| 1 | 1.1 Initialize VS Code Fork | ✅ COMPLETED |

### In Progress Stories
| Epic | Story | Status |
|------|-------|--------|
| 2 | 2.1 Adapt stackcode-chat Extension for Stackspot AI | 🔄 IN PROGRESS (Clone done, needs modification) |

### Remaining Stories
| Epic | Stories | Status |
|------|---------|--------|
| 1 | 1.2, 1.3 | 🔴 Not Started |
| 2 | 2.2, 2.3, 2.4 | 🔴 Not Started |
| 3 | 3.1 - 3.5 | 🔴 Not Started |
| 4 | 4.1 - 4.8 | 🔴 Not Started |

### Progress
- **Total Stories:** 20
- **Completed:** 1 (5%)
- **In Progress:** 1 (5%)
- **Remaining:** 18 (90%)

---

## ✅ Workflow Complete

O workflow **create-epics-and-stories** foi concluído com sucesso!

### Documento Gerado
- **Arquivo:** `/Users/darwin/Desktop/stackcode-stackspot-extension/stackcode/_bmad-output/planning-artifacts/epics.md`
- **Status:** ✅ Completo

### Validações Realizadas
- ✅ Todos os requisitos funcionais (FRs) mapeados para épicos
- ✅ Todos os requisitos não-funcionais (NFRs) mapeados para épicos
- ✅ Estrutura de épicos organizada por valor do usuário
- ✅ Histórias com critérios de aceite claros
- ✅ Sem dependências forward entre histórias
- ✅ Template seguido corretamente

---

Tem alguma dúvida sobre os épicos e histórias criados?