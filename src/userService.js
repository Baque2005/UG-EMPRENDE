import { supabase } from './config/supabase.js';

export const blockUser = async (blockerId, blockedId) => {
  if (!blockerId || !blockedId) return null;
  const payload = { blocker_id: blockerId, blocked_id: blockedId, created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('user_blocks').upsert(payload, { onConflict: ['blocker_id', 'blocked_id'] }).select().maybeSingle();
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase blockUser error', error);
    return null;
  }
  return data;
};

export const unblockUser = async (blockerId, blockedId) => {
  if (!blockerId || !blockedId) return false;
  const { error } = await supabase.from('user_blocks').delete().match({ blocker_id: blockerId, blocked_id: blockedId });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase unblockUser error', error);
    return false;
  }
  return true;
};

export const isBlockedBy = async (viewerId, senderId) => {
  if (!viewerId || !senderId) return false;
  const { data, error } = await supabase
    .from('user_blocks')
    .select('*')
    .eq('blocker_id', viewerId)
    .eq('blocked_id', senderId)
    .maybeSingle();
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase isBlockedBy error', error);
    return false;
  }
  return !!data;
};

export const muteUser = async (muterId, mutedId) => {
  if (!muterId || !mutedId) return null;
  const payload = { muter_id: muterId, muted_id: mutedId, created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('user_mutes').upsert(payload, { onConflict: ['muter_id', 'muted_id'] }).select().maybeSingle();
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase muteUser error', error);
    return null;
  }
  return data;
};

export const unmuteUser = async (muterId, mutedId) => {
  if (!muterId || !mutedId) return false;
  const { error } = await supabase.from('user_mutes').delete().match({ muter_id: muterId, muted_id: mutedId });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase unmuteUser error', error);
    return false;
  }
  return true;
};

export const isMutedBy = async (viewerId, senderId) => {
  if (!viewerId || !senderId) return false;
  const { data, error } = await supabase
    .from('user_mutes')
    .select('*')
    .eq('muter_id', viewerId)
    .eq('muted_id', senderId)
    .maybeSingle();
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Supabase isMutedBy error', error);
    return false;
  }
  return !!data;
};

export default { blockUser, unblockUser, isBlockedBy, muteUser, unmuteUser, isMutedBy };
