import type { GeometryType } from '../enums';
import type { IContourSet } from './IContourSet';
import type { IMesh } from './IMesh';
import type { ISurface } from './ISurface';

// interface IGeometry can be array of IContourSet
interface IGeometry {
  id: string;
  type: GeometryType;
  data: IContourSet | ISurface | IMesh;
  sizeInBytes: number;
}

export type { IGeometry as default };
