import { useEffect, useState } from 'react';
import { Button, Checkbox, Flash, FormControl, Heading, Text, TextInput } from '@primer/react';
import { ShieldLockIcon } from '@primer/octicons-react';
import { useAuth } from '../context/AuthContext';
import { canRememberSecret } from '../storage/desktopSecret';
import { Feature, Operation, Telemetry } from '../lib/telemetry';
import styles from './UnlockDialog.module.css';

/** Full-screen gate shown when an encrypted token exists but is locked. */
export function UnlockDialog() {
  const { unlock, forget, error } = useAuth();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const [canRemember, setCanRemember] = useState(false);

  useEffect(() => {
    let active = true;
    canRememberSecret().then((ok) => active && setCanRemember(ok));
    return () => {
      active = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Timed on its own: webcrypto.ts uses 600,000 PBKDF2 iterations, so this is the first
      // thing a user waits on at every unlock.
      await Telemetry.measure(Operation.TOKEN_DECRYPT, () => unlock(passphrase, remember));
      Telemetry.featureUsed(Feature.TOKEN_UNLOCKED);
      if (remember) Telemetry.featureUsed(Feature.TOKEN_REMEMBERED);
    } catch {
      // error surfaced via context
    } finally {
      setBusy(false);
      setPassphrase('');
    }
  };

  const onForget = async () => {
    if (window.confirm('Forget the stored token? You will need to paste it again.')) {
      await forget();
    }
  };

  return (
    <div className={styles.flexCentred}>
      <form
        onSubmit={submit}
        className={styles.roundedP4}
      >
        <div className={styles.flexCenter}>
          <ShieldLockIcon size={24} className={styles.accentFg} />
          <Heading as="h2" className={styles.title}>Unlock token</Heading>
        </div>
        <Text as="p" className={styles.fgMutedBody}>
          Your GitHub token is encrypted in this browser. Enter your passphrase to decrypt it
          for this session.
        </Text>
        {error && <Flash variant="danger" className={styles.mb3}>{error}</Flash>}
        <FormControl className={styles.mb3}>
          <FormControl.Label>Passphrase</FormControl.Label>
          <TextInput
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            block
            autoComplete="current-password"
          />
        </FormControl>
        {canRemember && (
          <FormControl className={styles.mb3}>
            <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <FormControl.Label>Remember on this device</FormControl.Label>
            <FormControl.Caption>
              Stores the passphrase in your OS keychain and unlocks automatically next time.
            </FormControl.Caption>
          </FormControl>
        )}
        <div className={styles.flexGap2}>
          <Button type="button" variant="danger" onClick={onForget}>
            Forget token
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !passphrase}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </div>
      </form>
    </div>
  );
}
