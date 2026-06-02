export type InsertionStatus = "draft" | "processed";

export type TextInsertion = {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  status: InsertionStatus;
};

export type PagePoint = {
  width: number;
  height: number;
};
