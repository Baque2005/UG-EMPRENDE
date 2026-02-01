import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { blockUser, unblockUser, muteUser, unmuteUser } from '../userService.js';
import { supabase } from '../config/supabase.js';

const router = Router();

// Block a user (current user blocks target)
router.post('/:id/block', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const result = await blockUser(req.user.id, targetId);
    if (!result) return res.status(400).json({ error: 'No se pudo bloquear' });
    return res.status(201).json({ blocked: true, entry: result });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/block', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const ok = await unblockUser(req.user.id, targetId);
    if (!ok) return res.status(400).json({ error: 'No se pudo desbloquear' });
    return res.json({ blocked: false });
  } catch (err) {
    return next(err);
  }
});

// Consultar estado de bloqueo (bidireccional)
// - blockedByMe: yo bloqueé al target
// - blockedMe: el target me bloqueó
router.get('/:id/block/status', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const me = req.user.id;

    if (!targetId) return res.status(400).json({ error: 'Falta id' });
    if (!me) return res.status(401).json({ error: 'No autorizado' });

    const [{ data: byMe, error: byMeErr }, { data: byOther, error: byOtherErr }] = await Promise.all([
      supabase
        .from('user_blocks')
        .select('blocker_id')
        .match({ blocker_id: me, blocked_id: targetId })
        .maybeSingle(),
      supabase
        .from('user_blocks')
        .select('blocker_id')
        .match({ blocker_id: targetId, blocked_id: me })
        .maybeSingle(),
    ]);

    if (byMeErr) return res.status(400).json({ error: byMeErr.message });
    if (byOtherErr) return res.status(400).json({ error: byOtherErr.message });

    return res.json({ blockedByMe: Boolean(byMe), blockedMe: Boolean(byOther) });
  } catch (err) {
    return next(err);
  }
});

// Mute a user (current user mutes target)
router.post('/:id/mute', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const result = await muteUser(req.user.id, targetId);
    if (!result) return res.status(400).json({ error: 'No se pudo silenciar' });
    return res.status(201).json({ muted: true, entry: result });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/mute', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const ok = await unmuteUser(req.user.id, targetId);
    if (!ok) return res.status(400).json({ error: 'No se pudo desilenciar' });
    return res.json({ muted: false });
  } catch (err) {
    return next(err);
  }
});

export default router;
