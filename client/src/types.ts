export type Pt = { x: number; y: number };
export type InkPt = { x: number; y: number; p?: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Box = { left: number; top: number; width: number; height: number };

export type Style = { color: string; width: number; opacity: number; fontSize: number };
export type AnnType = 'ink' | 'highlight' | 'text' | 'note' | 'image';
export type Tool =
  | 'select' | 'ink' | 'eraser' | 'highlight' | 'rect' | 'text' | 'note' | 'image';

export type Annotation = {
  _id: string;
  documentId: string;
  pageIndex: number;
  type: AnnType;
  data: any;
  style: Style;
  /** Paint order within a page. Higher sits on top. */
  z?: number;
  /** Locked annotations cannot be moved, resized, erased or deleted. */
  locked?: boolean;
};

export type DocMeta = {
  _id: string;
  originalName: string;
  filename: string;
  pageCount: number;
  thumbnailAssetId?: string;
  updatedAt: string;
  deletedAt?: string;
  /** Pages kept in the file but skipped in the viewer and at export. */
  hiddenPages?: number[];
  /** Where the reader was when this document was last closed. */
  lastPage?: number;
};

export type Preset = { name: string; tool: Tool; style: Style };

/** ordinal is the match number within that page, used to scroll to the exact hit */
export type SearchMatch = { pageIndex: number; ordinal: number };
