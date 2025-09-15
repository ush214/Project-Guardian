/**
 * Wreck Loader - Utility to load and resolve coordinates from wreck documents
 */

import { Firestore } from 'firebase-admin/firestore';

interface Wreck {
  id: string;
  collectionPath: string;
  coordinates: { lat: number; lon: number } | null;
  depth?: number;
  data: any;
}

const READ_COLLECTIONS = [
  "artifacts/guardian/public/data/werpassessments",
  "artifacts/guardian-agent-default/public/data/werpassessments"
];

export class WreckLoader {
  constructor(private db: Firestore) {}

  async loadAllWrecks(): Promise<Wreck[]> {
    const wrecks: Wreck[] = [];

    for (const collectionPath of READ_COLLECTIONS) {
      console.log(`Loading wrecks from: ${collectionPath}`);
      
      const collection = this.db.collection(collectionPath);
      const snapshot = await collection.get();
      
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const coordinates = this.resolveCoordinates(data);
        
        if (coordinates) {
          wrecks.push({
            id: doc.id,
            collectionPath,
            coordinates,
            depth: this.resolveDepth(data),
            data
          });
        } else {
          console.warn(`Skipping wreck ${doc.id} - no valid coordinates found`);
        }
      }
    }

    console.log(`Loaded ${wrecks.length} wrecks with valid coordinates`);
    return wrecks;
  }

  private resolveCoordinates(data: any): { lat: number; lon: number } | null {
    // Try various coordinate field paths
    const coordPaths = [
      ['coordinates'],
      ['location', 'coordinates'],
      ['historical', 'location', 'coordinates'],
      ['geometry', 'coordinates'],
      ['position'],
      ['latLng']
    ];

    for (const path of coordPaths) {
      const coords = this.getNestedValue(data, path);
      
      if (coords && typeof coords === 'object') {
        // Handle different coordinate formats
        if (typeof coords.lat === 'number' && (typeof coords.lon === 'number' || typeof coords.lng === 'number')) {
          return {
            lat: coords.lat,
            lon: coords.lon || coords.lng
          };
        }
        
        // Handle GeoJSON-style coordinates [lng, lat]
        if (Array.isArray(coords) && coords.length >= 2) {
          const [lng, lat] = coords;
          if (typeof lng === 'number' && typeof lat === 'number') {
            return { lat, lon: lng };
          }
        }
      }
    }

    return null;
  }

  private resolveDepth(data: any): number | undefined {
    const depthPaths = [
      ['depth'],
      ['location', 'depth'],
      ['historical', 'location', 'depth'],
      ['geometry', 'depth'],
      ['depthMeters'],
      ['depth_m']
    ];

    for (const path of depthPaths) {
      const depth = this.getNestedValue(data, path);
      if (typeof depth === 'number' && depth > 0) {
        return depth;
      }
    }

    return undefined;
  }

  private getNestedValue(obj: any, path: string[]): any {
    let current = obj;
    for (const key of path) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }
    return current;
  }
}