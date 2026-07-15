import { createRoot, type Root } from 'react-dom/client';
import UpdateBanner from '../../src/components/UpdateBanner';
import { useUpdateCheck } from '../../src/hooks/useUpdateCheck';

let root: Root | null = null;

function UpdateNotificationHarness() {
  const updateCheck = useUpdateCheck({ currentVersion: '1.1.2', enabled: true });
  return updateCheck.update ? (
    <UpdateBanner
      version={updateCheck.update.version}
      url={updateCheck.update.url}
      onDismiss={updateCheck.dismiss}
    />
  ) : null;
}

/** Mount the production hook and banner together under the Vite E2E runtime. */
export function mountUpdateNotificationHarness(host: HTMLElement) {
  root?.unmount();
  root = createRoot(host);
  root.render(<UpdateNotificationHarness />);
}
