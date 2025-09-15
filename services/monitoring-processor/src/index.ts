/**
 * Monitoring Processor Cloud Run Service
 * 
 * Responsibilities:
 * - Load wreck documents from both assessment collections
 * - Process USGS earthquake data and compute distances/PGA
 * - Process NHC storm data and compute distances 
 * - Write structured events to Firestore per wreck
 */

import express from 'express';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { EarthquakeProcessor } from './processors/earthquakes.js';
import { StormProcessor } from './processors/storms.js';
import { WreckLoader } from './utils/wreckLoader.js';

const app = express();
const port = process.env.PORT || 8080;

// Initialize Firebase
const firebaseApp = initializeApp({
  // In Cloud Run, ADC is used automatically
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.PROJECT_ID
});

const db = getFirestore(firebaseApp);

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Manual earthquake processing endpoint
app.post('/process-earthquakes', async (req, res) => {
  try {
    const { hoursBack = 6 } = req.body;
    
    console.log(`Starting earthquake processing for last ${hoursBack} hours`);
    
    const wreckLoader = new WreckLoader(db);
    const wrecks = await wreckLoader.loadAllWrecks();
    
    const earthquakeProcessor = new EarthquakeProcessor(db);
    const results = await earthquakeProcessor.processEarthquakes(wrecks, hoursBack);
    
    res.json({
      success: true,
      processed: results.processed,
      events: results.events,
      wrecks: wrecks.length
    });
  } catch (error) {
    console.error('Error processing earthquakes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Manual storm processing endpoint  
app.post('/process-storms', async (req, res) => {
  try {
    console.log('Starting storm processing');
    
    const wreckLoader = new WreckLoader(db);
    const wrecks = await wreckLoader.loadAllWrecks();
    
    const stormProcessor = new StormProcessor(db);
    const results = await stormProcessor.processStorms(wrecks);
    
    res.json({
      success: true,
      processed: results.processed,
      events: results.events,
      wrecks: wrecks.length
    });
  } catch (error) {
    console.error('Error processing storms:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Combined processing endpoint (for scheduled jobs)
app.post('/process-all', async (req, res) => {
  try {
    const { earthquakeHours = 6 } = req.body;
    
    console.log('Starting combined monitoring processing');
    
    const wreckLoader = new WreckLoader(db);
    const wrecks = await wreckLoader.loadAllWrecks();
    
    // Process earthquakes
    const earthquakeProcessor = new EarthquakeProcessor(db);
    const earthquakeResults = await earthquakeProcessor.processEarthquakes(wrecks, earthquakeHours);
    
    // Process storms
    const stormProcessor = new StormProcessor(db);
    const stormResults = await stormProcessor.processStorms(wrecks);
    
    res.json({
      success: true,
      earthquakes: {
        processed: earthquakeResults.processed,
        events: earthquakeResults.events
      },
      storms: {
        processed: stormResults.processed,
        events: stormResults.events
      },
      wrecks: wrecks.length
    });
  } catch (error) {
    console.error('Error in combined processing:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Monitoring processor listening on port ${port}`);
});

export default app;