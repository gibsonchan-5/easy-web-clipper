export interface WebClippersSettings {
  savePath: string;
  fileNameTemplate: string;
  includeFrontMatter: boolean;
  includeSourceUrl: boolean;
  includeClipDate: boolean;
  openAfterClip: boolean;
}

export const DEFAULT_SETTINGS: WebClippersSettings = {
  savePath: 'Easy Web Clipper',
  fileNameTemplate: '{{title}}',
  includeFrontMatter: true,
  includeSourceUrl: true,
  includeClipDate: true,
  openAfterClip: true,
};
