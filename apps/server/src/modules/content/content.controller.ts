import { Controller, Get, Query, Param, ParseIntPipe } from '@nestjs/common';
import { ContentService } from './content.service.js';

@Controller('api/content')
export class ContentController {
  constructor(private contentService: ContentService) {}

  @Get('subjects')
  getSubjects() {
    return this.contentService.getSubjects();
  }

  @Get('versions')
  getVersions(@Query('subjectId', ParseIntPipe) subjectId: number) {
    return this.contentService.getVersions(subjectId);
  }

  @Get('versions/:versionId/units')
  getUnits(@Param('versionId', ParseIntPipe) versionId: number) {
    return this.contentService.getUnits(versionId);
  }

  @Get('versions/:versionId/units/:unitId/lessons')
  getLessons(@Param('unitId', ParseIntPipe) unitId: number) {
    return this.contentService.getLessons(unitId);
  }
}
