import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';

@Public()
@Controller('hyfitgames/health')
export class HfgHealthController {
  @Get()
  health() {
    return { ok: true, ts: new Date().toISOString() };
  }
}
