# Global Lang Workspace

This folder now contains two independent projects that can be committed and deployed separately:

1. **node-app/** – WebRTC web client + Node.js proxy for OpenAI APIs.
2. **python-service/** – FastAPI backend that runs the offline speech translation pipeline.

Clone this repository, then initialise standalone Git repos inside each directory if you plan to host them separately:

```bash
cd node-app
git init
git add .
git commit -m "Initial commit"

cd ../python-service
git init
git add .
git commit -m "Initial commit"
```

Each subproject includes its own README, Render configuration (`render.yaml`), and `.gitignore`. See those files for detailed setup instructions.
