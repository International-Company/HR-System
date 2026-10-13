import { useEffect } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import './clipboardGuard.css';

const BLOCKED = ['copy', 'cut', 'paste', 'dragstart', 'drop'] as const;

/**
 * Inside the signed-in app: no copying, cutting, pasting, dragging or selecting text (owner's policy).
 * Sign-in, MFA and recovery-code screens are outside the app layout and stay unaffected.
 * Elements marked data-allow-clipboard are exempt. This deters casual copying; it cannot stop
 * screenshots or browser developer tools.
 */
export function useClipboardGuard(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const block = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('[data-allow-clipboard]')) return;
      // Dropping files onto an upload area stays possible; dropping text does not.
      if (e.type === 'drop' && (e as DragEvent).dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      if (e.type !== 'dragstart') {
        // One message at a time, so repeated attempts do not stack up.
        notifications.show({ id: 'clipboard-blocked', color: 'gray', message: t('app.clipboardBlocked'), autoClose: 2500 });
      }
    };
    document.body.classList.add('hrms-no-copy');
    for (const type of BLOCKED) document.addEventListener(type, block, true);
    return () => {
      document.body.classList.remove('hrms-no-copy');
      for (const type of BLOCKED) document.removeEventListener(type, block, true);
    };
  }, [t]);
}
