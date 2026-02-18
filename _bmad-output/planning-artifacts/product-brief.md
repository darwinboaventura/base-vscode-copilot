---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
date: 2026-02-18
author: Darwin
workflow_status: complete
workflow_completed: 2026-02-18
---

# Product Brief: stackcode

<!-- Content will be appended sequentially through collaborative workflow steps -->

## Executive Summary

**stackcode** é um fork do VS Code que replica exatamente a experiência do GitHub Copilot, mas com uma diferença fundamental: utiliza exclusivamente o provedor de LLM Stackspot AI como backend para todas as funcionalidades de IA, garantindo privacidade, conformidade legal e segurança em ambientes corporativos.

---

## Core Vision

### Problem Statement

O direito fundamental à privacidade de dados é uma garantia essencial na era digital. Desenvolvedores de software em ambientes corporativos enfrentam uma limitação crítica: não podem utilizar ferramentas de AI Coding Agents como Cursor, Claude Code ou GitHub Copilot porque essas ferramentas enviam código proprietário e contexto sensível para provedores de LLM externos (Microsoft/OpenAI/Anthropic), violando o direito fundamental à privacidade de dados, políticas corporativas de segurança e regulamentações como LGPD/GDPR.

### Problem Impact

- **Violação de privacidade:** Código proprietário e dados sensíveis são transmitidos para servidores externos sem controle
- **Não conformidade legal:** Violação de LGPD/GDPR e políticas de segurança da informação
- **Perda de produtividade:** Desenvolvedores não podem usar ferramentas de IA em seus ambientes de trabalho
- **Risco de propriedade intelectual:** Exposição de código proprietário a terceiros não autorizados
- **Impossibilidade de auditoria:** Não há como verificar onde e como os dados são processados

### Why Existing Solutions Fall Short

Todas as soluções existentes de AI Coding Agents (Cursor, Claude Code, GitHub Copilot, Amazon CodeWhisperer, Tabnine) transmitem dados para provedores de LLM externos. Não existe alternativa que:
- Garanta 100% de controle sobre os dados
- Permita uso exclusivo de provedores internos/autorizados
- Ofereça compatibilidade total com o ecossistema VS Code
- Mantenha conformidade total com políticas de segurança corporativas

### Proposed Solution

Criar um fork do VS Code que oferece **controle total e absoluto** sobre os dados:

1. **100% Controlado:** Substitui completamente o backend do Copilot pelo Stackspot AI
2. **Experiência Nativa:** Replica EXATAMENTE a interface e funcionalidades do GitHub Copilot
3. **Zero Vazamento:** Remove todas as requisições para servidores não autorizados
4. **Compatibilidade Total:** Mantém 100% das funcionalidades do VS Code upstream
5. **Provedor Único:** Utiliza apenas a extensão `./extensions/stackcode-chat` como backend de LLM

### Key Differentiators

- **Controle 100%:** Total domínio sobre onde dados são processados e armazenados
- **Conformidade Legal Guaranteed:** Alignment total com LGPD/GDPR, políticas corporativas e requisitos de auditoria
- **Privacidade como Direito Fundamental:** O usuário mantém propriedade e controle total sobre seu código
- **Experiência Idêntica:** Zero curva de aprendizado - exatamente como o usuário espera do Copilot
- **Provedor Autorizado:** Stackspot AI como único backend de LLM permitted e auditado

## Target Users

### Primary Users

**Desenvolvedores de Software (Todos os níveis)**

O produto serve desenvolvedores de software em ambientes corporativos que precisam de ferramentas de AI Coding, mas estão restritos por políticas de segurança, privacidade e conformidade legal.

#### Perfis de Usuário:

1. **Desenvolvedor Júnior**
   - Contexto: Começando na carreira, aprendendo boas práticas de código
   - Necessidade: Orientação e sugestões de IA para aprender e escrever código melhor
   - Problema: Não pode usar Copilot por políticas corporativas

2. **Desenvolvedor Pleno**
   - Contexto: Desenvolvedor independente, foco em produtividade pessoal
   - Necessidade: Escrever código mais rápido, debug eficiente, refatoração segura
   - Problema: Precisa de IA mas não pode enviar dados para provedores externos

3. **Desenvolvedor Sênior**
   - Contexto: Especialista técnico, lidera projetos complexos
   - Necessidade: Manter alta produtividade com segurança e conformidade
   - Problema: Código proprietário não pode sair da empresa

**Casos de Uso:**
- Escrever código (autocomplete, sugestões, completions)
- Debugging (análise de erros, sugestões de correção)
- Refatoração (sugestões de melhoria, code smells)
- Revisão de código (análise, explicações, optimizations)

### Secondary Users

N/A - O produto é focado exclusivamente no desenvolvedor individual. Não há papéis de gestão ou admin relevantes para esta solução.

### User Journey

1. **Discovery (Descoberta):**
   - Desenvolvedor descobre que empresa não permite Copilot/ferramentas externas
   - Pesquisa alternativas e encontra apenas opções que enviam dados para fora
   - Frustração por não poder usar IA que aumentaria produtividade

2. **Onboarding (Integração):**
   - Baixa o fork stackcode (mesmo processo que VS Code)
   - Instala extensão stackcode-chat
   - Configura autenticação com Stackspot AI
   - ZERO curva de aprendizado - interface idêntica ao Copilot

3. **Core Usage (Uso Principal):**
   - Escreve código com autocomplete de IA via Stackspot AI
   - Pede explicações de código via chat integrado
   - Debugging com assistência inteligente
   - Refatoração com sugestões de melhoria
   - Revisão de código assistida por IA

4. **Success Moment (Momento de Sucesso):**
   - "Funciona EXATAMENTE como o Copilot!"
   - Pode usar IA legalmente no ambiente corporativo
   - Produtividade aumenta sem preocupações com privacidade

5. **Long-term (Uso em Longo Prazo):**
   - stackcode se torna ferramenta padrão da equipe
   - Empresa pode adotar para todos os desenvolvedores
   - Satisfação por ter privacidade e produtividade garantidas

## Success Metrics

### User Success Metrics

1. **Experiência Idêntica ao Copilot**
   - Definição: Usuário não percebe diferença entre usar stackcode e VS Code + Copilot original
   - Meta: >= 9/10 na pesquisa de satisfação
   - Método: Pesquisa quantitativa "stackcode funciona igual ao Copilot"

2. **Zero Vazamento de Dados**
   - Definição: Nenhuma requisição HTTP/websocket para servidores diferentes do Stackspot AI
   - Meta: 0 requisições para microsoft/openai/anthropic
   - Método: Monitoramento de rede e logs de extensão

3. **Funcionalidade 100%**
   - Definição: Todas as features do Copilot funcionam corretamente
   - Meta: 100% das features implementadas
   - Método: Checklist de funcionalidades comparadas com Copilot

### Business Objectives

1. **Compatibilidade Total (Launch)**
   - Objetivo: Todas as features do GitHub Copilot funcionam no fork
   - Indicador: Feature parity checklist

2. **Privacidade Garantida (Contínuo)**
   - Objetivo: Zero vazamento de dados para provedores não autorizados
   - Indicador: Monitoramento de rede mostra 0 requisições externas

3. **Experiência Nativa (Contínuo)**
   - Objetivo: Usuário não percebe diferença no fluxo de trabalho
   - Indicador: Satisfação do usuário e tickets de suporte

### Key Performance Indicators

| KPI | Meta | Prazo | Método de Medição |
|-----|------|-------|-------------------|
| Feature Parity | 100% | Lançamento | Checklist de funcionalidades |
| Zero Data Leakage | 0 requisições | Contínuo | Monitoramento de rede |
| UX Score | >= 9/10 | Contínuo | Pesquisa de satisfação |
| Onboarding Success | 100% | Contínuo | Taxa de usuários que configuram Stackspot AI |

## MVP Scope

### Core Features

**O MVP deve incluir 100% das funcionalidades do GitHub Copilot:**

1. **Autocomplete**
   - Inline completions em tempo real
   - Multiple suggestions
   - Accept/reject functionality

2. **Copilot Chat**
   - Interface idêntica ao Copilot Chat
   - Extensão em `./extensions/stackcode-chat`
   - Todos os recursos de chat (explain, fix, generate, etc.)

3. **Inline Suggestions**
   - Ghost text rendering
   - Accept with Tab
   - Dismiss with Escape

4. **Commands**
   - /explain - Explicar código
   - /fix - Corrigir problemas
   - /generate - Gerar código
   - /test - Gerar testes
   - Todos os outros comandos do Copilot

5. **Settings**
   - Configurações de comportamento
   - Seleção de linguagem
   - Configurações de privacy

6. **Authentication**
   - Integração com Stackspot AI
   - Login/logout flow
   - Token management

### Out of Scope for MVP

**N/A** - O objetivo é 100% de compatibilidade com Copilot. Todas as funcionalidades são essenciais.

### MVP Success Criteria

| Critério | Meta | Validação |
|----------|------|-----------|
| Feature Parity | 100% | Checklist comparando com Copilot |
| Zero Data Leakage | 0 requisições externas | Monitoramento de rede |
| Experience Parity | >= 9/10 | Pesquisa de satisfação |
| Build & Run | Fork compila | Build successful |

### Future Vision

Este é um fork de compatibilidade. O objetivo é manter 100% de paridade com o VS Code upstream. Qualquer nova funcionalidade além da compatibilidade com Copilot deve ser proposta como extensão adicional do stackcode.
