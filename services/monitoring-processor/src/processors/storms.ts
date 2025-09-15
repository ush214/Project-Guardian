/**
 * Storm Processor - Fetches NHC storm data and processes storm proximity for wrecks
 */

import { Firestore } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

interface Wreck {
  id: string;
  collectionPath: string;
  coordinates: { lat: number; lon: number };
  depth?: number;
  data: any;
}

interface NHCStorm {
  id: string;
  name: string;
  classification: string;
  intensity: string;
  pressure: number;
  windSpeed: number;
  movement: string;
  lat: number;
  lon: number;
  lastUpdate: string;
}

interface ProcessedStormEvent {
  source: string;
  eventId: string;
  timeMs: number;
  stormName: string;
  classification: string;
  intensity: string;
  windSpeed: number;
  pressure: number;
  lat: number;
  lng: number;
  distanceKm: number;
  threshold: number;
  exceeded: boolean;
  message: string;
  createdAtMs: number;
}

export class StormProcessor {
  private readonly DISTANCE_THRESHOLD_KM = 500; // 500km threshold for shallow wrecks
  private readonly SHALLOW_DEPTH_METERS = 60; // Define shallow wreck depth
  
  constructor(private db: Firestore) {}

  async processStorms(wrecks: Wreck[]): Promise<{ processed: number; events: number }> {
    console.log(`Processing storms for ${wrecks.length} wrecks`);
    
    // Filter to shallow wrecks only (as per requirements)
    const shallowWrecks = wrecks.filter(wreck => 
      !wreck.depth || wreck.depth <= this.SHALLOW_DEPTH_METERS
    );
    
    console.log(`Filtered to ${shallowWrecks.length} shallow wrecks (depth <= ${this.SHALLOW_DEPTH_METERS}m)`);
    
    // Fetch active storms
    const storms = await this.fetchActiveStorms();
    console.log(`Found ${storms.length} active storms`);
    
    let processed = 0;
    let events = 0;
    
    for (const wreck of shallowWrecks) {
      for (const storm of storms) {
        const distance = this.calculateDistance(
          wreck.coordinates.lat,
          wreck.coordinates.lon,
          storm.lat,
          storm.lon
        );
        
        const event: ProcessedStormEvent = {
          source: "nhc",
          eventId: `${storm.id}_${Date.now()}`,
          timeMs: new Date(storm.lastUpdate).getTime(),
          stormName: storm.name,
          classification: storm.classification,
          intensity: storm.intensity,
          windSpeed: storm.windSpeed,
          pressure: storm.pressure,
          lat: storm.lat,
          lng: storm.lon,
          distanceKm: Math.round(distance * 100) / 100,
          threshold: this.DISTANCE_THRESHOLD_KM,
          exceeded: distance <= this.DISTANCE_THRESHOLD_KM,
          message: `${storm.classification} ${storm.name} (${storm.intensity}) ${Math.round(distance)}km away, ${storm.windSpeed}mph winds`,
          createdAtMs: Date.now()
        };

        await this.saveStormEvent(wreck, event);
        events++;
        processed++;
      }
    }
    
    console.log(`Processed ${processed} storm-wreck combinations, created ${events} events`);
    return { processed, events };
  }

  private async fetchActiveStorms(): Promise<NHCStorm[]> {
    try {
      // Try NHC API first - note this is a simplified approach
      // In production, you'd want to parse the actual NHC feeds more robustly
      const response = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json');
      
      if (response.ok) {
        const data = await response.json() as any;
        return this.parseNHCData(data);
      }
    } catch (error) {
      console.warn('Failed to fetch from NHC API, falling back to GDACS:', error);
    }
    
    // Fallback to GDACS (Global Disaster Alert and Coordination System)
    return this.fetchGDACSStorms();
  }

  private parseNHCData(data: any): NHCStorm[] {
    const storms: NHCStorm[] = [];
    
    // Parse NHC JSON structure (simplified)
    if (data && Array.isArray(data.activeStorms)) {
      for (const storm of data.activeStorms) {
        if (storm.lat && storm.lon) {
          storms.push({
            id: storm.id || storm.name || `storm_${Date.now()}`,
            name: storm.name || 'Unnamed Storm',
            classification: storm.classification || 'Tropical Storm',
            intensity: storm.intensity || 'Unknown',
            pressure: storm.pressure || 0,
            windSpeed: storm.windSpeed || 0,
            movement: storm.movement || '',
            lat: parseFloat(storm.lat),
            lon: parseFloat(storm.lon),
            lastUpdate: storm.lastUpdate || new Date().toISOString()
          });
        }
      }
    }
    
    return storms;
  }

  private async fetchGDACSStorms(): Promise<NHCStorm[]> {
    try {
      const response = await fetch('https://www.gdacs.org/gdacsapi/api/events/geteventlist?eventtype=TC');
      
      if (!response.ok) {
        throw new Error(`GDACS API error: ${response.status}`);
      }
      
      const data = await response.json() as any;
      const storms: NHCStorm[] = [];
      
      if (data && Array.isArray(data.features)) {
        for (const feature of data.features) {
          const props = feature.properties || {};
          const geom = feature.geometry || {};
          
          if (geom.coordinates && Array.isArray(geom.coordinates)) {
            storms.push({
              id: props.eventid || `gdacs_${Date.now()}`,
              name: props.eventname || props.name || 'Unnamed Cyclone',
              classification: 'Tropical Cyclone',
              intensity: props.severitydata?.severity || 'Unknown',
              pressure: props.pressure || 0,
              windSpeed: props.windspeed || 0,
              movement: '',
              lat: geom.coordinates[1],
              lon: geom.coordinates[0],
              lastUpdate: props.fromdate || new Date().toISOString()
            });
          }
        }
      }
      
      return storms;
    } catch (error) {
      console.error('Error fetching GDACS storms:', error);
      return [];
    }
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    // Haversine formula
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  private async saveStormEvent(wreck: Wreck, event: ProcessedStormEvent): Promise<void> {
    const eventPath = `${wreck.collectionPath}/${wreck.id}/monitoring/storms/events/${event.eventId}`;
    
    try {
      await this.db.doc(eventPath).set(event, { merge: true });
      
      if (event.exceeded) {
        console.log(`🌀 Storm proximity threshold exceeded for wreck ${wreck.id}: ${event.message}`);
      }
    } catch (error) {
      console.error(`Error saving storm event for wreck ${wreck.id}:`, error);
      throw error;
    }
  }
}