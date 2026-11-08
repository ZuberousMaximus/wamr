import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PartyPopper, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Alert, AlertDescription } from '../ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { useToast } from '../../hooks/use-toast';
import type { ApiError } from '../../services/api.client';
import {
  getGroupRecap,
  getWhatsAppGroups,
  previewGroupRecap,
  saveGroupRecap,
  sendGroupRecapNow,
  type GroupRecapConfig,
  type RecapDraft,
} from '../../services/group-recap.client';

const BRIEF_LIMIT = 1000;

const KIND_LABELS: Record<RecapDraft['kind'], string> = {
  recap: 'Gemini recap of this week’s requests',
  quip: 'Quiet week, so Gemini wrote a quip',
  template: 'Plain recap (Gemini unavailable)',
  skip: 'Nothing would be sent: quiet week and Gemini is unavailable',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return (error as ApiError)?.message || fallback;
}

export function GroupRecapCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<GroupRecapConfig | null>(null);
  const [draft, setDraft] = useState<RecapDraft | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const recapQuery = useQuery({ queryKey: ['group-recap'], queryFn: getGroupRecap });
  const groupsQuery = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: getWhatsAppGroups,
    retry: false,
  });

  // Seed the form once, then leave it to the user until they save
  useEffect(() => {
    if (recapQuery.data && !form) setForm(recapQuery.data.config);
  }, [recapQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: saveGroupRecap,
    onSuccess: (result) => {
      setForm(result.config);
      queryClient.invalidateQueries({ queryKey: ['group-recap'] });
      toast({
        title: 'Group recap saved',
        description: result.config.enabled
          ? `Next recap: ${formatWhen(result.state.nextRunAt)}`
          : 'Group recap is off.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Error',
        description: errorMessage(error, 'Failed to save group recap.'),
        variant: 'destructive',
      }),
  });

  const previewMutation = useMutation({
    mutationFn: (brief: string) => previewGroupRecap(brief),
    onSuccess: setDraft,
    onError: (error) =>
      toast({
        title: 'Error',
        description: errorMessage(error, 'Failed to generate a preview.'),
        variant: 'destructive',
      }),
  });

  const sendMutation = useMutation({
    mutationFn: sendGroupRecapNow,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['group-recap'] });
      setDraft(result);
      toast({
        title: result.text ? 'Sent to the group' : 'Nothing sent',
        description: result.text ? KIND_LABELS[result.kind] : KIND_LABELS.skip,
      });
    },
    onError: (error) =>
      toast({
        title: 'Error',
        description: errorMessage(error, 'Failed to send the recap.'),
        variant: 'destructive',
      }),
  });

  if (!form || !recapQuery.data) {
    return null;
  }

  const { state, llmEnabled, serverTimeZone } = recapQuery.data;
  const saved = recapQuery.data.config;
  const groups = groupsQuery.data?.groups ?? [];
  // Keep the saved group selectable even when WhatsApp is offline
  const groupOptions =
    form.groupJid && !groups.some((g) => g.id === form.groupJid)
      ? [{ id: form.groupJid, name: form.groupName ?? form.groupJid, size: 0 }, ...groups]
      : groups;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const windowInvalid = form.windowStart >= form.windowEnd;
  const update = (patch: Partial<GroupRecapConfig>) => setForm({ ...form, ...patch });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PartyPopper className="h-5 w-5" />
          Group Recap
        </CardTitle>
        <CardDescription>
          Once a week, on a random day, post a funny recap of the week’s requests to a WhatsApp
          group. Quiet weeks get a movie/TV quip instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!llmEnabled && (
          <Alert>
            <AlertDescription>
              Gemini is off ({recapQuery.data.llmDisabledReason ?? 'not configured'}), so recaps use
              a plain template and quiet weeks are skipped. Set <code>LLM_ENABLED=true</code> and{' '}
              <code>LLM_API_KEY</code> to turn it on.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="group-recap-enabled">Enable Weekly Recap</Label>
            <p className="text-sm text-muted-foreground">Posts automatically, once per week</p>
          </div>
          <Switch
            id="group-recap-enabled"
            checked={form.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Group</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => groupsQuery.refetch()}
              disabled={groupsQuery.isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${groupsQuery.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <Select
            value={form.groupJid ?? undefined}
            onValueChange={(id) =>
              update({
                groupJid: id,
                groupName: groupOptions.find((g) => g.id === id)?.name ?? null,
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose a group WAMR is in" />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                  {g.size > 0 ? ` (${g.size})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {groupsQuery.isError && (
            <p className="text-sm text-muted-foreground">
              {errorMessage(groupsQuery.error, 'Could not load groups')}. Connect WhatsApp and
              refresh.
            </p>
          )}
          {groupsQuery.isSuccess && groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              The linked WhatsApp account isn’t in any groups yet. Add it to one, then refresh.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Posting Window</Label>
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={form.windowStart}
              onChange={(e) => update({ windowStart: e.target.value })}
              className="w-32"
              aria-label="Earliest time"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="time"
              value={form.windowEnd}
              onChange={(e) => update({ windowEnd: e.target.value })}
              className="w-32"
              aria-label="Latest time"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            A random day each week (Mon-Sun), at a random time in this window. Server time zone:{' '}
            {serverTimeZone}.
          </p>
          {windowInvalid && (
            <p className="text-sm text-destructive">The start time must be before the end time.</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="group-recap-brief">Brief for Gemini (optional)</Label>
          <textarea
            id="group-recap-brief"
            value={form.brief}
            maxLength={BRIEF_LIMIT}
            rows={4}
            onChange={(e) => update({ brief: e.target.value })}
            placeholder="e.g. We're a family group, keep it clean. Sam always requests horror, roast him for it. Use some Urdu slang. Mention movie night is Friday."
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
          />
          <p className="text-right text-xs text-muted-foreground">
            {form.brief.length}/{BRIEF_LIMIT}
          </p>
        </div>

        {saved.enabled && (
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <p>
              <span className="text-muted-foreground">Next recap:</span>{' '}
              {formatWhen(state.nextRunAt)}
            </p>
            <p>
              <span className="text-muted-foreground">Last recap:</span>{' '}
              {formatWhen(state.lastRunAt)}
              {state.lastResult ? ` - ${state.lastResult}` : ''}
            </p>
          </div>
        )}

        {draft && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {KIND_LABELS[draft.kind]}
              {draft.requestCount > 0 ? ` - ${draft.requestCount} requests` : ''}
            </p>
            {draft.text && (
              <div className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
                {draft.text}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => saveMutation.mutate(form)}
            disabled={
              !dirty || windowInvalid || (form.enabled && !form.groupJid) || saveMutation.isPending
            }
          >
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
          <Button
            variant="outline"
            onClick={() => previewMutation.mutate(form.brief)}
            disabled={previewMutation.isPending}
          >
            {previewMutation.isPending ? 'Writing...' : 'Preview'}
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirmSend(true)}
            disabled={!saved.groupJid || dirty || sendMutation.isPending}
            title={dirty ? 'Save your changes first' : undefined}
          >
            {sendMutation.isPending ? 'Sending...' : 'Send Now'}
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Post to {saved.groupName ?? 'the group'} now?</AlertDialogTitle>
            <AlertDialogDescription>
              A fresh recap is written and posted straight away. It won’t be the same text as the
              preview. The weekly schedule isn’t affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => sendMutation.mutate()}>Send</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
