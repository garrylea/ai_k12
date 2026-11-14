import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConversationList from './ConversationList';
import { listAllConversations } from '@/services/api';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, listAllConversations: vi.fn() };
});

const listMock = vi.mocked(listAllConversations);

beforeEach(() => {
  listMock.mockReset();
  useAuxiliaryStore.setState({ conversations: [], currentDialogueId: null });
});

afterEach(() => cleanup());

describe('ConversationList：做题答疑会话', () => {
  it('同时查答疑与做题会话，并要求只返回聊过天的做题会话', async () => {
    listMock.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <ConversationList />
      </MemoryRouter>,
    );
    await screen.findByText('暂无历史会话');
    expect(listMock).toHaveBeenCalledWith('auxiliary', ['aux_qna', 'aux_freeform'], { hasChat: true });
  });
});
