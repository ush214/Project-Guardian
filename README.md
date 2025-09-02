# Project-Guardian
AI Enabled WERP Protocol Assessment Web App
Project Guardian is an advanced intelligence platform designed to address the global environmental threat of potentially polluting shipwrecks. It transforms the manual, research-intensive task of risk assessment into a dynamic, automated, and scalable process.

This web-based application serves as the front-end for a sophisticated AI agent that leverages Google's Gemini model to perform deep-dive research on legacy shipwrecks. It automatically generates a comprehensive risk profile based on the Wreck Environmental Risk Prioritisation (WERP) Protocol, providing a clear, data-driven foundation for prioritizing and planning remediation efforts.

The agent's intelligence-led approach allows for rapid, global-scale assessment, moving beyond the limitations of a traditional evidence-led scientific process and preventing "prioritisation paralysis."

2. Core Features
AI-Powered Analysis: Enter the name of a wreck, and the AI agent conducts a multi-step research and analysis process, generating a detailed report in minutes.

Interactive Global Map: Visualizes the locations of all analyzed wrecks, with markers color-coded by their overall risk level.

Detailed Popups: Click on any wreck on the map to see an at-a-glance summary of its key WERP scores.

Database Integration: All analyses are automatically saved to a Firestore database, creating a persistent and growing intelligence asset.

Instant Retrieval: The agent checks the database before starting a new analysis. If a wreck has been previously assessed, its report is loaded instantly, saving time and resources.

Advanced Data Visualization: Each report includes a WERP Risk Profile spider chart, which plots the wreck's scores against established risk benchmarks for intuitive and immediate comprehension.

Professional UI: The user interface is designed to mirror the professional aesthetic of a corporate intelligence report.

3. The WERP Protocol: A Multi-Factor Framework
The agent's analysis is built on the four core pillars of the WERP protocol:

Wreck Condition Score (WCS): Assesses the physical state of the wreck. It considers the vessel's age, size, the violence of its sinking, and its current structural integrity.

Pollutant Hazard Score (PHS): Quantifies the volume and toxicity of the hazardous materials onboard, including fuel, munitions, and persistent organic pollutants (POPs).

Environmental Sensitivity Index (ESI): The "wrong place" factor. This score measures the ecological and economic vulnerability of the wreck's location, considering its proximity to coral reefs, fisheries, and tourism-dependent coastlines.

Release Probability Modifier (RPM): A forward-looking multiplier that accounts for environmental stressors like ocean warming, seismic activity, and storm frequency that are actively accelerating the wreck's decay.

4. Technology Stack
Frontend: HTML5, Tailwind CSS

Backend & Database: Google Firebase (Firestore, Authentication, Hosting)

AI & Research Engine: Google Gemini 2.5 Flash

Mapping: Leaflet.js

Data Visualization: Chart.js

5. Setup and Deployment via GitHub Actions
This guide details how to deploy Project Guardian using a modern, automated workflow that links a GitHub repository to Firebase Hosting.

Prerequisites
A Google Account to create a Firebase project.

A GitHub Account to host the code repository.

Node.js and npm installed on your local machine.

Step-by-Step Instructions
1. Set Up Your GitHub Repository
Create a new, public repository on GitHub (e.g., project-guardian-app).

Create a local project folder on your computer (e.g., project-guardian-local).

Clone the empty repository to your local folder or initialize git within it (git init).

2. Set Up Your Firebase Project
Go to the Firebase Console and create a new project.

Crucially, you must upgrade your project to the "Blaze (Pay-as-you-go)" plan. This is mandatory for the Gemini API calls to function in a live environment. The plan includes a generous free tier.

3. Install Firebase CLI & Initialize the Project
Open a terminal and install the Firebase Command Line Interface:

npm install -g firebase-tools

Navigate into your local project folder (cd path/to/project-guardian-local).

Log in to Firebase:

firebase login

Initialize Firebase Hosting:

firebase init hosting

Answer the prompts as follows:

Select Use an existing project and choose the project you just created.

For the public directory, enter public.

Configure as a single-page app? N.

Set up automatic builds and deploys with GitHub? Y.

4. Connect Firebase to GitHub
The CLI will open a browser window to authorize Firebase with your GitHub account.

Provide your repository name when prompted (e.g., your-username/project-guardian-app).

Set up the workflow to run a build script? N.

Set up automatic deployment on merge? Y.

Deploy from the main branch (or your primary branch name).

5. Structure and Push Your Project
Ensure your local project folder (project-guardian-local) has the following structure:

project-guardian-local/
├── .github/                 # Created by Firebase CLI
│   └── workflows/
│       └── ...workflow-file.yml
├── public/
│   └── index.html           # Your main application file
├── .firebaserc              # Created by Firebase CLI
├── firebase.json            # Created by Firebase CLI
└── README.md                # This file

Commit and push all the files to your GitHub repository:

git add .
git commit -m "Initial setup of Project Guardian application"
git push origin main

Your application will now be automatically deployed. You can check the "Actions" tab in your GitHub repository to monitor the progress and find your live Hosting URL in the deployment logs.

6. Usage
Once deployed, using the agent is simple:

Navigate to the provided Firebase Hosting URL.

The map and list will populate with any previously analyzed wrecks.

To analyze a new wreck, type its name into the input field and click "Analyze Wreck".

The agent will perform its multi-step analysis, providing real-time status updates.

Once complete, the full report and spider chart will be displayed, and the wreck will be added to the map and the persistent database.
