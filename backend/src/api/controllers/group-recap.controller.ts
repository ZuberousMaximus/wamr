import { Request, Response, NextFunction } from 'express';
import {
  groupRecapService,
  groupRecapConfigSchema,
} from '../../services/group-recap/group-recap.service.js';
import { whatsappClientService } from '../../services/whatsapp/whatsapp-client.service.js';
import { llmService } from '../../services/llm/llm.service.js';
import { logger } from '../../config/logger.js';

export const groupRecapController = {
  /** GET /api/group-recap - config, schedule state and whether the LLM is on */
  async get(_req: Request, res: Response, next: NextFunction) {
    try {
      const [config, state] = await Promise.all([
        groupRecapService.getConfig(),
        groupRecapService.getState(),
      ]);
      res.json({
        config,
        state,
        llmEnabled: llmService.isEnabled(),
        llmDisabledReason: llmService.getDisabledReason(),
        // Schedule times are in this zone; set TZ on the container to change it
        serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    } catch (error) {
      next(error);
    }
  },

  /** PUT /api/group-recap */
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = groupRecapConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: parsed.error.errors[0]?.message ?? 'Invalid group recap settings',
          details: parsed.error.errors,
        });
        return;
      }
      const result = await groupRecapService.saveConfig(parsed.data);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  /** GET /api/group-recap/groups - groups the linked WhatsApp account is in */
  async groups(_req: Request, res: Response) {
    if (!whatsappClientService.isReady()) {
      res.status(503).json({ code: 'WHATSAPP_NOT_READY', message: 'WhatsApp is not connected' });
      return;
    }
    try {
      res.json({ groups: await whatsappClientService.listGroups() });
    } catch (error) {
      logger.error({ error }, 'Failed to list WhatsApp groups');
      res
        .status(502)
        .json({ code: 'GROUPS_UNAVAILABLE', message: 'Could not load groups from WhatsApp' });
    }
  },

  /** POST /api/group-recap/preview - generate without sending */
  async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const brief = req.body?.brief;
      if (brief !== undefined && (typeof brief !== 'string' || brief.length > 1000)) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Brief must be text of at most 1000 characters',
        });
        return;
      }
      res.json(await groupRecapService.preview(brief));
    } catch (error) {
      next(error);
    }
  },

  /** POST /api/group-recap/send-now */
  async sendNow(_req: Request, res: Response) {
    if (!whatsappClientService.isReady()) {
      res.status(503).json({ code: 'WHATSAPP_NOT_READY', message: 'WhatsApp is not connected' });
      return;
    }
    try {
      const draft = await groupRecapService.sendNow();
      res.json({ ...draft, state: await groupRecapService.getState() });
    } catch (error) {
      logger.error({ error }, 'Manual group recap failed');
      res.status(500).json({
        code: 'SEND_FAILED',
        message: error instanceof Error ? error.message : 'Failed to send group recap',
      });
    }
  },
};
