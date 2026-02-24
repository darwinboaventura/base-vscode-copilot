# Plano de Correção: Problemas de UI no StackCode

## Problemas Identificados

### 1. Mensagem enganosa "Response cleared due to content safety filters"
**Sintoma:** A mensagem aparece mesmo quando o conteúdo não tem nada de restrito, apenas formato inválido ou resposta vazia.

**Causa:** Em `pseudoStartStopConversationCallback.ts:183-184`, quando `retryReason` é `MalformedFormat` ou `EmptyResponse`, o código cai no `else` e usa `FilteredContentRetry`, que mostra a mensagem de filtros de segurança.

**Solução:** Adicionar casos específicos para `MalformedFormat` e `EmptyResponse` usando `NoReason` em vez de `FilteredContentRetry`.

**Arquivo:** `src/extension/prompt/node/pseudoStartStopConversationCallback.ts`

---

### 2. JSON sendo exibido no chat
**Sintoma:** Quando o LLM envia tool calls sem as tags XML `<tool_use>`, o JSON cru aparece no chat em vez de ser processado silenciosamente.

**Causa:** Quando extração estruturada resgata tool calls de respostas malformadas, o texto acumulado em `plainTextParts` (que inclui o JSON) continua sendo enviado para o chat via `buildFullText()`.

**Solução:** Quando extração estruturada é bem-sucedida, limpar `plainTextParts` e usar apenas o texto "fora" das tool calls (via `parser.outsideAccumulatorText`) em vez de todo o texto acumulado.

**Arquivo:** `src/platform/endpoint/node/stackspotChatEndpoint.ts`

**Mudanças específicas:**
1. Adicionar `parser.outsideAccumulatorText` ao `buildFullText()` quando extração estruturada resgata tool calls
2. Ou alternativamente, limpar `plainTextParts` quando extração for bem-sucedida

---

## Checklist de Implementação

- [ ] Fix 1: Modificar `pseudoStartStopConversationCallback.ts` linhas 179-185
- [ ] Fix 2: Modificar `stackspotChatEndpoint.ts` na seção de extração estruturada (linhas 390-405)
- [ ] Verificar typecheck
- [ ] Rebuild com esbuild
- [ ] Rodar testes unitários

## Estimativa

Implementação: ~10 minutos
Testes: ~5 minutos
Total: ~15 minutos
