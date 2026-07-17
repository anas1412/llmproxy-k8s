import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RelayService } from './relay.service.js';
import { TokenAuthGuard, type AuthenticatedRequest } from '../auth/token-auth.guard.js';

@Controller()
export class RelayController {
  constructor(private readonly relay: RelayService) {}

  @Get('v1/models')
  getModels(@Res() res: Response): void {
    const models = this.relay.getModels();
    res.json({ object: 'list', data: models });
  }

  @Post('v1/chat/completions')
  @UseGuards(TokenAuthGuard)
  async chatCompletions(@Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    const route = req.route;
    const body = await this.readBody(req);
    await this.relay.relayChatCompletion(route, body, req.headers as Record<string, string | string[]>, res);
  }

  @Post('v1/messages')
  @UseGuards(TokenAuthGuard)
  async messages(@Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    const route = req.route;
    const body = await this.readBody(req);
    // Anthropic endpoint — handled by the same relay logic, which detects channel type
    await this.relay.relayChatCompletion(route, body, req.headers as Record<string, string | string[]>, res);
  }

  private async readBody(req: Request, limit = 20 * 1024 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { reject(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}
