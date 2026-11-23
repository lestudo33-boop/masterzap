import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown, renderMasterIAPanel } from '../../src/components/MasterIAPanel.js';
import { MASTER_IA_CONFIG, chatCompletionsUrl } from '../../src/lib/master-ia-config.js';
import { MasterIAService, NO_EVIDENCE_MESSAGE, requestNosana } from '../../src/lib/master-ia.js';
import { loadSearchIndex, resetSearchIndex, search } from '../../src/lib/search.js';

function makeStore({ dates = [], messages = [] } = {}) {
  return {
    async getConversationIndex() {
      return dates;
    },
    async getMessagesForDates() {
      return messages;
    },
    async getMessages() {
      return messages;
    },
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Master IA corpus service', () => {
  beforeEach(() => resetSearchIndex());

  it('counts exact textual occurrences separately from sent messages and participation', async () => {
    const conversation = {
      id: 'ana-silva',
      contact: 'Ana Silva',
      participants: ['DV', 'Ana Silva'],
      total_messages: 2,
    };
    const store = makeStore({
      dates: [{ date: '2025-01-01' }],
      messages: [
        { id: 1, date: '2025-01-01', time: '10:00:00', sender: 'DV', type: 'text', content: 'Ana Silva chegou. ANA SILVA falou; banana.' },
        { id: 2, date: '2025-01-01', time: '10:01:00', sender: 'Ana Silva', type: 'text', content: 'A conversa com ana silva.' },
      ],
    });
    const service = new MasterIAService({ store });

    const result = await service.answer(
      'Quantas vezes Ana Silva é mencionada?',
      [conversation],
    );

    expect(result.local).toBe(true);
    expect(result.text).toContain('**3** vez(es)');
    expect(result.text).toContain('**2** mensagem(ns)');
    expect(result.text).not.toContain('3 mensagem(ns)');
    expect(result.sources).toHaveLength(2);
  });

  it('counts a named third party even when they are not a chat participant', async () => {
    const conversation = {
      id: 'chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const service = new MasterIAService({
      store: makeStore({
        dates: [{ date: '2025-01-01' }],
        messages: [{
          id: 8,
          date: '2025-01-01',
          sender: 'DV',
          type: 'text',
          content: 'Paulo Gonet ligou para Paulo Gonet.',
        }],
      }),
    });

    const result = await service.answer('Quantas vezes Paulo Gonet é citado?', [conversation]);

    expect(result.text).toContain('**2** vez(es)');
    expect(result.text).toContain('**1** mensagem(ns)');
  });

  it('uses the full date chunks when a large conversation index truncates the text', async () => {
    const conversation = {
      id: 'large-chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 6001,
    };
    const fetcher = vi.fn(async () => ({
      ok: true,
      async json() {
        return [{ id: 7, date: '2025-01-01', sender: 'Contato', content: 'texto resumido' }];
      },
    }));
    const store = makeStore({
      dates: [{ date: '2025-01-01' }],
      messages: [{
        id: 7,
        date: '2025-01-01',
        time: '12:00:00',
        sender: 'Contato',
        type: 'text',
        content: 'Esta evidência aparece depois do limite do índice: palavra-completa',
      }],
    });
    const service = new MasterIAService({
      store,
      fetcher,
      config: { ...MASTER_IA_CONFIG, maxEvidence: 5 },
    });

    const evidence = await service.retrieveEvidence('Encontre palavra-completa', [conversation]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].content).toContain('depois do limite do índice');
    expect(evidence[0].messageId).toBe(7);
  });

  it('requires multiple whole query terms for indexed evidence', async () => {
    const conversation = {
      id: 'chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 3,
    };
    const messages = [
      { id: 1, date: '2025-01-01', sender: 'Contato', type: 'text', content: 'Banco Master aprovou a operação.' },
      { id: 2, date: '2025-01-01', sender: 'Contato', type: 'text', content: 'O Banco Central analisou a operação.' },
      { id: 3, date: '2025-01-01', sender: 'Contato', type: 'text', content: 'Mastercard aprovou a operação.' },
    ];
    const fetcher = vi.fn(async () => jsonResponse(messages.map(({ id, date, sender, content }) => ({
      id, date, sender, content,
    }))));
    const service = new MasterIAService({
      store: makeStore({ dates: [{ date: '2025-01-01' }], messages }),
      fetcher,
    });

    const evidence = await service.retrieveEvidence('Banco Master', [conversation]);

    expect(evidence.map(source => source.messageId)).toEqual([1]);
  });

  it('applies the same whole-term requirement during deep search', async () => {
    const conversation = {
      id: 'large-chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 6001,
    };
    const messages = [
      { id: 1, date: '2025-01-01', sender: 'Contato', type: 'text', content: 'Banco Master aprovou a operação.' },
      { id: 2, date: '2025-01-01', sender: 'Contato', type: 'text', content: 'O Banco Central analisou a operação.' },
      { id: 3, date: '2025-01-01', sender: 'Contato', type: 'text', content: 'Mastercard aprovou a operação.' },
    ];
    const store = {
      ...makeStore({ dates: [{ date: '2025-01-01' }] }),
      async getMessagesForDates() {
        return messages;
      },
    };
    const service = new MasterIAService({
      store,
      fetcher: async () => jsonResponse([]),
    });

    const evidence = await service.retrieveEvidence('Banco Master', [conversation]);

    expect(evidence.map(source => source.messageId)).toEqual([1]);
  });

  it('reuses search indexes already loaded by the regular search panel', async () => {
    const conversation = {
      id: 'chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const fetcher = vi.fn(async () => jsonResponse([]));
    await loadSearchIndex('active-chat', '/data', {
      fetcher: async () => jsonResponse([{
        id: 1,
        date: '2025-01-01',
        content: 'active term',
      }]),
    });
    await loadSearchIndex('chat', '/data', {
      fetcher: async () => jsonResponse([{
        id: 8,
        date: '2025-01-01',
        content: 'A reunião aconteceu no escritório.',
      }]),
      activate: false,
    });
    const service = new MasterIAService({
      store: makeStore({
        dates: [{ date: '2025-01-01' }],
        messages: [{
          id: 8,
          date: '2025-01-01',
          sender: 'Contato',
          type: 'text',
          content: 'A reunião aconteceu no escritório.',
        }],
      }),
      fetcher,
    });

    const evidence = await service.retrieveEvidence('O que aconteceu na reunião?', [conversation]);

    expect(fetcher).not.toHaveBeenCalled();
    expect(evidence).toHaveLength(1);
    expect(search('active term')).toHaveLength(1);
  });

  it('scans large conversations in parallel date batches', async () => {
    const conversation = {
      id: 'large-chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 6001,
    };
    const dates = Array.from({ length: 24 }, (_, index) => ({
      date: `2025-01-${String(index + 1).padStart(2, '0')}`,
    }));
    let activeBatches = 0;
    let maxActiveBatches = 0;
    const store = {
      ...makeStore({ dates }),
      async getMessagesForDates(_conversationId, batchDates) {
        activeBatches++;
        maxActiveBatches = Math.max(maxActiveBatches, activeBatches);
        await new Promise(resolve => setTimeout(resolve, 0));
        activeBatches--;
        return batchDates.map((entry, index) => ({
          id: index + 1,
          date: entry,
          sender: 'Contato',
          type: 'text',
          content: 'Uma palavra-completa no conteúdo',
        }));
      },
    };
    const service = new MasterIAService({
      store,
      fetcher: async () => jsonResponse([]),
    });

    const evidence = await service.retrieveEvidence('Encontre palavra-completa', [conversation]);

    expect(maxActiveBatches).toBeGreaterThan(1);
    expect(evidence.length).toBeGreaterThan(0);
  });

  it('deep-searches large conversations even when another conversation has index hits', async () => {
    const conversations = [
      {
        id: 'small-chat',
        contact: 'Conversa pequena',
        participants: ['DV', 'Contato'],
        total_messages: 1,
      },
      {
        id: 'large-chat',
        contact: 'Conversa grande',
        participants: ['DV', 'Outro contato'],
        total_messages: 6001,
      },
    ];
    const messages = {
      'small-chat': [{
        id: 1,
        date: '2025-01-01',
        sender: 'Contato',
        type: 'text',
        content: 'Uma palavra-completa no índice.',
      }],
      'large-chat': [{
        id: 2,
        date: '2025-01-02',
        sender: 'Outro contato',
        type: 'text',
        content: 'Uma palavra-completa que não aparece no índice truncado.',
      }],
    };
    const store = {
      async getConversationIndex(conversationId) {
        return [{ date: conversationId === 'large-chat' ? '2025-01-02' : '2025-01-01' }];
      },
      async getMessagesForDates(conversationId) {
        return messages[conversationId];
      },
      async getMessages(conversationId) {
        return messages[conversationId];
      },
    };
    const fetcher = vi.fn(async url => {
      const isLargeChat = url.includes('/large-chat/');
      return jsonResponse([{
        id: isLargeChat ? 2 : 1,
        date: isLargeChat ? '2025-01-02' : '2025-01-01',
        content: isLargeChat ? 'texto resumido' : 'palavra-completa no índice',
      }]);
    });
    const service = new MasterIAService({ store, fetcher });

    const evidence = await service.retrieveEvidence('Encontre palavra-completa', conversations);

    expect(evidence.map(source => source.conversationId)).toContain('large-chat');
    expect(evidence.map(source => source.conversationId)).toContain('small-chat');
  });

  it('skips deep search when a large conversation index already has enough evidence', async () => {
    const conversation = {
      id: 'large-chat',
      contact: 'Conversa grande',
      participants: ['DV', 'Contato'],
      total_messages: 6001,
    };
    const messages = [1, 2].map(id => ({
      id,
      date: '2025-01-01',
      sender: 'Contato',
      type: 'text',
      content: `Mensagem ${id} com palavra-completa.`,
    }));
    const getMessagesForDates = vi.fn(async () => []);
    const store = {
      async getConversationIndex() {
        return [{ date: '2025-01-01' }];
      },
      getMessagesForDates,
      async getMessages() {
        return messages;
      },
    };
    const fetcher = vi.fn(async () => jsonResponse(messages.map(message => ({
      id: message.id,
      date: message.date,
      content: message.content,
    }))));
    const service = new MasterIAService({
      store,
      fetcher,
      config: { ...MASTER_IA_CONFIG, maxEvidence: 2 },
    });

    const evidence = await service.retrieveEvidence('Encontre palavra-completa', [conversation]);

    expect(evidence).toHaveLength(2);
    expect(getMessagesForDates).not.toHaveBeenCalled();
  });

  it('returns the fixed insufficient-evidence response without calling the model', async () => {
    const conversation = {
      id: 'empty',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const fetcher = vi.fn(async () => ({ ok: true, async json() { return []; } }));
    const service = new MasterIAService({ store: makeStore(), fetcher });

    const result = await service.answer('O que dizem sobre um assunto ausente?', [conversation]);

    expect(result.text).toBe(NO_EVIDENCE_MESSAGE);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps locally recovered sources visible when inference is unavailable', async () => {
    const conversation = {
      id: 'chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const message = {
      id: 8,
      date: '2025-01-01',
      time: '10:00:00',
      sender: 'Contato',
      type: 'text',
      content: 'A reunião aconteceu no escritório.',
    };
    const fetcher = vi.fn(async url => {
      if (url.includes('search-index.json')) {
        return jsonResponse([{ id: message.id, date: message.date, content: message.content }]);
      }
      throw new TypeError('Failed to fetch');
    });
    const service = new MasterIAService({
      store: makeStore({
        dates: [{ date: message.date }],
        messages: [message],
      }),
      fetcher,
    });

    const result = await service.answer('O que aconteceu na reunião?', [conversation]);

    expect(result.local).toBe(true);
    expect(result.synthesisAvailable).toBe(false);
    expect(result.text).toContain('não foi possível concluir a resposta agora');
    expect(result.text).toContain('Tente novamente em instantes');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].messageId).toBe(message.id);
  });

  it('answers participant questions from conversation metadata', async () => {
    const conversation = {
      id: 'alexandre-de-moraes',
      contact: 'Alexandre de Moraes',
      participants: ['DV', 'Alexandre de Moraes BRASILIA'],
      date_range: { start: '2025-09-17', end: '2025-11-17' },
      total_messages: 79,
    };
    const service = new MasterIAService({ store: makeStore() });

    const result = await service.answer(
      'Quem participa da conversa com Alexandre de Moraes?',
      [conversation],
    );

    expect(result.local).toBe(true);
    expect(result.text).toContain('Alexandre de Moraes BRASILIA');
    expect(result.sources[0].conversationId).toBe('alexandre-de-moraes');
  });
});

describe('Nosana Chat Completions client', () => {
  it('sends only the question and retrieved evidence to the configured endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'Resposta documental.' } }],
    }));
    const config = {
      baseUrl: 'https://inference.example',
      model: 'gpt-oss:20b',
      stream: false,
      maxContextChars: 12000,
    };

    const answer = await requestNosana({
      question: 'O que ocorreu?',
      evidence: [{
        conversationId: 'chat-1',
        messageId: 3,
        date: '2025-01-01',
        time: '09:00:00',
        sender: 'DV',
        participants: ['DV', 'Contato'],
        content: 'Mensagem original.',
      }],
      config,
      fetcher,
    });

    expect(answer).toBe('Resposta documental.');
    expect(fetcher).toHaveBeenCalledWith(
      'https://inference.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST', credentials: 'omit' }),
    );
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request.model).toBe('gpt-oss:20b');
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1].content).toContain('Mensagem original.');
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('reads streaming tokens and reports accumulated text', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Res"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"posta"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const onToken = vi.fn();

    const answer = await requestNosana({
      question: 'O que ocorreu?',
      evidence: [],
      config: { ...MASTER_IA_CONFIG, baseUrl: 'https://inference.example' },
      fetcher,
      onToken,
    });

    expect(answer).toBe('Resposta');
    expect(onToken).toHaveBeenLastCalledWith('Resposta');
  });

  it('aborts an active streaming response when the user stops generation', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Parcial"}}]}\n\n'));
      },
    });
    const fetcher = vi.fn(async () => new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const controller = new AbortController();
    const onToken = vi.fn();
    const request = requestNosana({
      question: 'O que ocorreu?',
      evidence: [],
      config: { ...MASTER_IA_CONFIG, baseUrl: 'https://inference.example' },
      fetcher,
      onToken,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(onToken).toHaveBeenCalledWith('Parcial'));
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the active answer in view as streamed text arrives', async () => {
    const conversation = {
      id: 'chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const message = {
      id: 1,
      date: '2025-01-01',
      time: '10:00:00',
      sender: 'Contato',
      type: 'text',
      content: 'A reuniao ocorreu na quinta-feira.',
    };
    const store = {
      getConversations: () => [conversation],
      async getConversationIndex() {
        return [{ date: message.date }];
      },
      async getMessagesForDates() {
        return [message];
      },
      async getMessages() {
        return [message];
      },
    };
    const encoder = new TextEncoder();
    let releaseSecondChunk;
    const secondChunkReady = new Promise(resolve => { releaseSecondChunk = resolve; });
    let finishStream;
    const streamFinished = new Promise(resolve => { finishStream = resolve; });
    const fetcher = vi.fn(async url => {
      if (url.includes('search-index.json')) {
        return jsonResponse([{ id: message.id, date: message.date, content: message.content }]);
      }
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"A reuniao"}}]}\n\n'));
          await secondChunkReady;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" ocorreu na quinta-feira."}}]}\n\n'));
          await streamFinished;
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const panel = renderMasterIAPanel({
      store,
      config: { ...MASTER_IA_CONFIG, baseUrl: 'https://inference.example' },
      fetcher,
    });
    document.body.appendChild(panel);
    const messages = panel.querySelector('.master-ia-messages');
    let scrollTop = 0;
    Object.defineProperties(messages, {
      scrollHeight: { configurable: true, get: () => messages.textContent.length * 4 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => { scrollTop = value; },
      },
    });

    try {
      const input = panel.querySelector('.master-ia-input');
      input.value = 'O que ocorreu na reuniao?';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      panel.querySelector('.master-ia-send').click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.master-ia-message-assistant').textContent).toContain('A reuniao');
      });

      expect(messages.classList.contains('is-generating')).toBe(true);
      await vi.waitFor(() => {
        expect(messages.scrollHeight - messages.clientHeight - messages.scrollTop).toBeLessThanOrEqual(64);
      });
      expect(panel.dataset.generationState).toBe('streaming');
      scrollTop = 0;
      messages.dispatchEvent(new Event('scroll'));
      releaseSecondChunk();
      await vi.waitFor(() => {
        expect(panel.querySelector('.master-ia-message-assistant').textContent).toContain('quinta-feira');
      });
      expect(messages.scrollTop).toBe(0);

      scrollTop = messages.scrollHeight - messages.clientHeight;
      messages.dispatchEvent(new Event('scroll'));
      finishStream();
      await vi.waitFor(() => {
        expect(messages.classList.contains('is-generating')).toBe(false);
      });
      await vi.waitFor(() => {
        expect(messages.scrollHeight - messages.clientHeight - messages.scrollTop).toBeLessThanOrEqual(1);
      });
      expect(panel.querySelector('.master-ia-message-assistant').dataset.state).toBe('completed');
    } finally {
      releaseSecondChunk();
      finishStream();
      panel.remove();
    }
  });

  it('keeps locally recovered fallback answers neutral while reporting the inference error', async () => {
    const conversation = {
      id: 'fallback-chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const message = {
      id: 8,
      date: '2025-01-01',
      time: '10:00:00',
      sender: 'Contato',
      type: 'text',
      content: 'A reunião aconteceu no escritório.',
    };
    const store = makeStore({
      dates: [{ date: message.date }],
      messages: [message],
    });
    const fetcher = vi.fn(async url => {
      if (url.includes('search-index.json')) {
        return jsonResponse([{ id: message.id, date: message.date, content: message.content }]);
      }
      throw new TypeError('Failed to fetch');
    });
    const panel = renderMasterIAPanel({ store, conversations: [conversation], fetcher });
    document.body.appendChild(panel);

    try {
      panel.querySelector('.master-ia-menu-button').click();
      panel.querySelector('.master-ia-reset').click();
      const input = panel.querySelector('.master-ia-input');
      input.value = 'O que aconteceu na reuniao?';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      panel.querySelector('.master-ia-send').click();

      await vi.waitFor(() => {
        const answer = panel.querySelector('.master-ia-message-assistant');
        expect(answer.textContent).toContain('não foi possível concluir a resposta agora');
      }, { timeout: 3000 });

      const answer = panel.querySelector('.master-ia-message-assistant');
      expect(answer.getAttribute('role')).toBe('alert');
      expect(answer.classList.contains('master-ia-message-error')).toBe(false);
      expect(answer.querySelector('.master-ia-source')).not.toBeNull();
    } finally {
      panel.remove();
    }
  });

  it('cancels a request and restores the composer', async () => {
    const conversation = {
      id: 'cancel-chat',
      contact: 'Contato',
      participants: ['DV', 'Contato'],
      total_messages: 1,
    };
    const store = makeStore({
      dates: [{ date: '2025-01-01' }],
      messages: [{
        id: 1,
        date: '2025-01-01',
        sender: 'Contato',
        type: 'text',
        content: 'Uma reunião importante.',
      }],
    });
    const fetcher = vi.fn(() => new Promise(resolve => {
      setTimeout(() => resolve(jsonResponse([{
        id: 1,
        date: '2025-01-01',
        content: 'Uma reunião importante.',
      }])), 500);
    }));
    const panel = renderMasterIAPanel({ store, conversations: [conversation], fetcher });
    document.body.appendChild(panel);

    try {
      panel.querySelector('.master-ia-menu-button').click();
      panel.querySelector('.master-ia-reset').click();
      const input = panel.querySelector('.master-ia-input');
      const send = panel.querySelector('.master-ia-send');
      input.value = 'O que aconteceu na reuniao?';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();

      expect(send.getAttribute('aria-label')).toBe('Parar geração');
      expect(panel.querySelector('.master-ia-message-user').textContent).toContain('O que aconteceu');
      send.click();

      await vi.waitFor(() => {
        expect(panel.querySelector('.master-ia-message-assistant')?.dataset.state).toBe('cancelled');
      });
      const answer = panel.querySelector('.master-ia-message-assistant');
      expect(answer.textContent).toContain('Geração interrompida');
      expect(input.disabled).toBe(false);
      expect(panel.dataset.generationState).toBe('idle');
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      panel.remove();
    }
  });

  it('keeps multiple sessions and supports copying and regenerating the latest answer', async () => {
    const conversation = {
      id: 'session-chat',
      contact: 'Alexandre de Moraes',
      participants: ['DV', 'Alexandre de Moraes BRASILIA'],
      total_messages: 1,
    };
    const panel = renderMasterIAPanel({
      store: makeStore(),
      conversations: [conversation],
      fetcher: vi.fn(),
    });
    document.body.appendChild(panel);

    try {
      panel.querySelector('.master-ia-menu-button').click();
      panel.querySelector('.master-ia-reset').click();
      const input = panel.querySelector('.master-ia-input');
      input.value = 'Quem participa da conversa com Alexandre de Moraes?';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      panel.querySelector('.master-ia-send').click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.master-ia-message-assistant')?.dataset.state).toBe('completed');
      });

      panel.querySelector('.master-ia-menu-button').click();
      panel.querySelector('.master-ia-reset').click();
      panel.querySelector('.master-ia-history-button').click();
      const priorSession = panel.querySelector('.master-ia-session-item');
      expect(priorSession.textContent).toContain('Quem participa da conversa');
      priorSession.click();

      const answer = panel.querySelector('.master-ia-message-assistant');
      expect(answer.querySelector('.master-ia-copy-answer')).not.toBeNull();
      expect(answer.querySelector('.master-ia-regenerate')).not.toBeNull();
      answer.querySelector('.master-ia-regenerate').click();
      await vi.waitFor(() => {
        expect(panel.querySelector('.master-ia-message-assistant')?.dataset.state).toBe('completed');
      });
      expect(panel.querySelectorAll('.master-ia-message-user')).toHaveLength(1);
    } finally {
      panel.remove();
    }
  });

  it('sends on Enter, preserves Shift+Enter, and resizes the composer', () => {
    const panel = renderMasterIAPanel({ store: makeStore(), conversations: [] });
    document.body.appendChild(panel);
    const input = panel.querySelector('.master-ia-input');
    const form = panel.querySelector('.master-ia-composer');
    const requestSubmit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => {});
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 96 });
    input.value = 'linha um\nlinha dois';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(input.style.height).toBe('96px');

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    panel.remove();
  });

  it('retries without streaming only when the endpoint explicitly rejects streaming', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'stream not supported' }, 400))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'Resposta sem streaming.' } }],
      }));

    const answer = await requestNosana({
      question: 'O que ocorreu?',
      evidence: [],
      config: { ...MASTER_IA_CONFIG, baseUrl: 'https://inference.example' },
      fetcher,
    });

    expect(answer).toBe('Resposta sem streaming.');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).stream).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).stream).toBe(false);
  });

  it('aborta uma análise que excede o tempo limite', async () => {
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }));

    await expect(requestNosana({
      question: 'O que ocorreu?',
      evidence: [],
      config: {
        ...MASTER_IA_CONFIG,
        baseUrl: 'https://inference.example',
        requestTimeoutMs: 10,
      },
      fetcher,
    })).rejects.toThrow('A análise demorou mais que o tempo esperado.');
  });

  it('keeps endpoint configuration in one module', () => {
    expect(chatCompletionsUrl()).toBe(
      '/api/master-ia/v1/chat/completions',
    );
    expect(MASTER_IA_CONFIG.model).toBe('gpt-oss:20b');
  });
});

describe('Master IA markdown renderer', () => {
  beforeEach(() => document.body.replaceChildren());

  it('renders common markdown while treating model HTML as plain text', () => {
    const rendered = renderMarkdown('**Fonte**\n\n<script>alert(1)</script> [link](javascript:alert(1))');
    document.body.appendChild(rendered);

    expect(rendered.querySelector('strong')?.textContent).toBe('Fonte');
    expect(rendered.querySelector('script')).toBeNull();
    expect(rendered.querySelector('a')).toBeNull();
    expect(rendered.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders fenced code, tables, blockquotes, and lists', () => {
    const rendered = renderMarkdown([
      '> **Fonte** confirmada',
      '',
      '```js',
      'console.log("ok");',
      '```',
      '',
      '| Nome | Total |',
      '| :--- | ---: |',
      '| Ana | 2 |',
      '',
      '- item um',
      '- item dois',
    ].join('\n'));

    expect(rendered.querySelector('blockquote strong')?.textContent).toBe('Fonte');
    expect(rendered.querySelector('.master-ia-code-block code')?.textContent).toBe('console.log("ok");');
    expect(rendered.querySelector('.master-ia-code-copy')).not.toBeNull();
    expect(rendered.querySelectorAll('.master-ia-table tbody tr')).toHaveLength(1);
    expect(rendered.querySelector('.master-ia-table th:last-child')?.style.textAlign).toBe('right');
    expect(rendered.querySelectorAll('ul li')).toHaveLength(2);
  });
});
