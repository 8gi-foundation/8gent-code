/**
 * 3D Architectural Project Utility
 * @module Architect
 */

/**
 * Represents a 3D architectural project
 */
export class Project {
  private elements: Element[] = [];

  /**
   * Add a wall element to the project
   * @param position - 3D coordinates [x, y, z]
   * @param dimensions - [width, height, depth]
   * @param material - Wall material type
   */
  addWall(position: number[], dimensions: number[], material: string): void {
    this.elements.push({
      type: 'wall',
      position,
      dimensions,
      material
    });
  }

  /**
   * Add a floor element to the project
   * @param position - 3D coordinates [x, y, z]
   * @param dimensions - [length, width, thickness]
   * @param material - Floor material type
   */
  addFloor(position: number[], dimensions: number[], material: string): void {
    this.elements.push({
      type: 'floor',
      position,
      dimensions,
      material
    });
  }

  /**
   * Add a window element to the project
   * @param position - 3D coordinates [x, y, z]
   * @param dimensions - [width, height]
   * @param material - Window material type
   */
  addWindow(position: number[], dimensions: number[], material: string): void {
    this.elements.push({
      type: 'window',
      position,
      dimensions,
      material
    });
  }

  /**
   * Export project as shareable data
   * @returns Serialized project data
   */
  export(): string {
    return btoa(JSON.stringify({
      elements: this.elements,
      createdAt: new Date().toISOString()
    }));
  }
}

/**
 * Create a new architectural project
 * @returns New Project instance
 */
export function createProject(): Project {
  return new Project();
}

/**
 * Interface for project elements
 */
interface Element {
  type: 'wall' | 'floor' | 'window';
  position: number[];
  dimensions: number[];
  material: string;
}