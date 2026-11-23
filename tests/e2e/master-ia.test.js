import { test, expect } from '@playwright/test';

test.describe('Master IA', () => {
  test('searches conversations outside the active phone profile', async ({ page }) => {
    await page.goto('/');
    if (page.viewportSize().width <= 600) {
      await page.locator('.sidebar-master-ia-link').click();
    } else {
      await page.locator('.nav-rail button[aria-label="Master IA"]').click();
    }

    await page.locator('.master-ia-input').fill('Quem participa da conversa com Roberto Teixeira?');
    await page.locator('.master-ia-send').click();

    const answer = page.locator('.master-ia-message-assistant');
    await expect(answer).toContainText('Metadados das conversas encontradas');
    await expect(answer).toContainText('Lula');
    await expect(answer.locator('.master-ia-dossier-name')).toHaveText('Roberto Teixeira');
  });

  test('answers from metadata and opens the cited conversation on desktop and mobile', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
    await page.goto('/');
    if (page.viewportSize().width <= 600) {
      await page.locator('.sidebar-master-ia-link').click();
    } else {
      await page.locator('.nav-rail button[aria-label="Master IA"]').click();
    }

    await expect(page).toHaveURL(/#\/master-ia$/);
    await expect(page.locator('.master-ia-panel')).toBeVisible();
    await expect(page.locator('.master-ia-brand img')).toHaveAttribute('src', '/assets/masterzap-logo.png');
    await expect(page.locator('.master-ia-welcome-logo')).toHaveAttribute('src', '/assets/masterzap-logo.png');
    await expect.poll(() => page.locator('.master-ia-brand img').evaluate(image => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.locator('.master-ia-welcome')).toContainText('O que você quer encontrar no acervo?');
    await expect(page.locator('.master-ia-suggestion')).toHaveCount(5);
    await expect(page.locator('.master-ia-notice')).toBeVisible();
    await page.locator('.master-ia-input').fill('Quem participa da conversa com Alexandre de Moraes?');
    await page.locator('.master-ia-send').click();

    const answer = page.locator('.master-ia-message-assistant');
    await expect(answer).toContainText('Metadados das conversas encontradas', { timeout: 15000 });
    await expect(answer).toContainText('Alexandre de Moraes BRASILIA');
    await expect(answer.locator('.master-ia-dataset')).toContainText('Acervo MasterWhats');
    await expect(answer.locator('.master-ia-dossier-action')).toHaveText('Ver conversa');
    await expect(answer.locator('.master-ia-graph-person')).toHaveCount(2);
    await expect(answer.locator('.master-ia-share')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await answer.locator('.master-ia-share').click();
    expect((await downloadPromise).suggestedFilename()).toBe('resposta-masteria.png');
    await page.locator('.master-ia-history-button').click();
    await expect(page.locator('.master-ia-history-popover')).toContainText('Quem participa da conversa');
    await page.locator('.master-ia-menu-button').click();
    await expect(page.locator('.master-ia-menu-popover .master-ia-reset')).toHaveText('Nova conversa');
    await page.locator('.master-ia-menu-button').click();

    await answer.locator('.master-ia-source').click();
    await expect(page).toHaveURL(/#\/chat\/alexandre-de-moraes$/);
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15000 });
  });
});
