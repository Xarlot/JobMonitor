import { useState } from 'react';
import { Box, Button, Flash, FormControl, Heading, Octicon, Text, TextInput } from '@primer/react';
import { ShieldLockIcon } from '@primer/octicons-react';
import { useAuth } from '../context/AuthContext';

/** Full-screen gate shown when an encrypted token exists but is locked. */
export function UnlockDialog() {
  const { unlock, forget, error } = useAuth();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await unlock(passphrase);
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
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', pt: 8, px: 3 }}>
      <Box
        as="form"
        onSubmit={submit}
        sx={{
          width: '100%',
          maxWidth: 420,
          border: '1px solid',
          borderColor: 'border.default',
          borderRadius: 2,
          p: 4,
          bg: 'canvas.subtle',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Octicon icon={ShieldLockIcon} size={24} sx={{ color: 'accent.fg' }} />
          <Heading as="h2" sx={{ fontSize: 3 }}>Unlock token</Heading>
        </Box>
        <Text as="p" sx={{ color: 'fg.muted', fontSize: 1, mb: 3 }}>
          Your GitHub token is encrypted in this browser. Enter your passphrase to decrypt it
          for this session.
        </Text>
        {error && <Flash variant="danger" sx={{ mb: 3 }}>{error}</Flash>}
        <FormControl sx={{ mb: 3 }}>
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
        <Box sx={{ display: 'flex', gap: 2, justifyContent: 'space-between' }}>
          <Button type="button" variant="danger" onClick={onForget}>
            Forget token
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !passphrase}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
