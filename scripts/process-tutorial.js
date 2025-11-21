const fs = require('fs-extra');
const path = require('path');
const unzipper = require('unzipper');
const { execSync } = require('child_process');

// --- CONFIGURATION ---
const REPO_OWNER = process.env.GITHUB_REPOSITORY_OWNER || "YourUsername";
const REPO_NAME = process.env.GITHUB_REPOSITORY? process.env.GITHUB_REPOSITORY.split('/')[1] : "YourRepo";
const UPLOADS_DIR = path.join(__dirname, '../uploads');
const TUTORIALS_BASE = path.join(__dirname, '../tutorials');
const DEVCONTAINER_BASE = path.join(__dirname, '../.devcontainer');

async function main() {
    // 1. Detect Zip File
    if (!fs.existsSync(UPLOADS_DIR)) return console.log("No uploads directory found.");
    const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.zip'));
    
    if (files.length === 0) return console.log("No zip files to process.");
    
    // Process the first found zip file
    const zipFilename = files;
    const tutorialName = path.basename(zipFilename, '.zip').replace(/[^a-zA-Z0-9-_]/g, ''); // Sanitize name
    const targetDir = path.join(TUTORIALS_BASE, tutorialName);
    
    console.log(`🚀 Processing Tutorial: ${tutorialName}`);

    // 2. Extract Content
    // Ensure clean target directory
    if (fs.existsSync(targetDir)) fs.removeSync(targetDir);
    fs.ensureDirSync(targetDir);

    await fs.createReadStream(path.join(UPLOADS_DIR, zipFilename))
      .pipe(unzipper.Extract({ path: targetDir }))
      .promise();
    
    console.log("✅ Extraction complete.");

    // 3. Load Tutorial Configuration
    const configPath = path.join(targetDir, 'tutorial-config.json');
    if (!fs.existsSync(configPath)) {
        console.error("❌ Error: tutorial-config.json not found in zip root.");
        throw new Error("tutorial-config.json missing in zip!");
        process.exit(1);
    }
    const tutorialConfig = fs.readJsonSync(configPath);

    // 4. Build Astro Starlight Project
    console.log("🔨 Building Astro Starlight project...");
    try {
        // Install dependencies and build. 
        // Assumes the zip root is the Astro project root.
        execSync('npm install && npm run build', { 
            cwd: targetDir, 
            stdio: 'inherit' 
        });
        
        // Move the 'dist' folder to 'steps' as requested
        const buildDir = path.join(targetDir, 'dist'); 
        const stepsDir = path.join(targetDir, 'steps');
        if (fs.existsSync(buildDir)) {
            fs.moveSync(buildDir, stepsDir, { overwrite: true });
            console.log("✅ Build successful. Output moved to /steps.");
        } else {
            console.error("⚠️  Build finished but 'dist' folder was not found.");
        }
    } catch (e) {
        console.error("❌ Astro build failed:", e.message);
        // We continue to generate files even if build fails, to allow debugging
    }

    // 5. Generate User Files (Boilerplate e.g., index.html, app.js)
    if (tutorialConfig.files && Array.isArray(tutorialConfig.files)) {
        tutorialConfig.files.forEach(fileName => {
            const filePath = path.join(targetDir, fileName);
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, `\n`);
                console.log(`📄 Created placeholder: ${fileName}`);
            }
        });
    }

    // 6. Generate Dynamic devcontainer.json
    await generateDevContainer(tutorialName, tutorialConfig);

    // 7. Generate README with Launch Button
    // This deep link points to the specific devcontainer configuration folder
    const deepLink = `https://codespaces.new/${REPO_OWNER}/${REPO_NAME}?devcontainer_path=.devcontainer/${tutorialName}/devcontainer.json`;
    
    const readmeContent = `
# ${tutorialName}

This tutorial environment has been automatically generated.

## Start Learning
Click the button below to launch a configured Codespace for this tutorial.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](${deepLink})

### Environment Details
- **Tutorial Steps**: Available in the preview pane (Port 3000).
- **Your Workspace**: Located in \`tutorials/${tutorialName}\`.
    `;
    fs.writeFileSync(path.join(targetDir, 'README.md'), readmeContent);

    // 8. Cleanup
    fs.removeSync(path.join(UPLOADS_DIR, zipFilename));
    console.log("🧹 Cleanup complete. Zip file removed.");
}

async function generateDevContainer(name, config) {
    const devContainerDir = path.join(DEVCONTAINER_BASE, name);
    fs.ensureDirSync(devContainerDir);

    // -- Port & Preview Configuration --
    // Port 3000: The Starlight Tutorial Steps
    const portsAttributes = {
        "3000": {
            "label": "Tutorial Guide",
            "onAutoForward": "openPreview"
        }
    };

    // Port 8080: The User's Live Preview (if 'browser' panel requested)
    if (config.panels && config.panels.includes('browser')) {
        portsAttributes["8080"] = {
            "label": "My Project Preview",
            "onAutoForward": "openPreview"
        };
    }

    // -- Startup Commands --
    // 1. Serve the 'steps' folder (static site) on port 3000
    // 2. Serve the current directory on port 8080 (if browser requested)
    // We use 'concurrently' or simple background '&' operators.
    
    let attachCommand = "nohup npx http-server steps -p 3000 --cors -c-1 > /dev/null 2>&1 &";
    
    if (config.panels && config.panels.includes('browser')) {
        // live-server provides hot reload for the user's index.html
        attachCommand += " nohup npx live-server. --port=8080 --no-browser > /dev/null 2>&1 &";
    }

    // -- The DevContainer Configuration Object --
    const devContainerConfig = {
        "name": `Tutorial: ${name}`,
        "image": "mcr.microsoft.com/devcontainers/typescript-node:18",
        
        // Isolate the user in the specific tutorial folder
        "workspaceFolder": `/workspaces/${REPO_NAME}/tutorials/${name}`,
        
        "features": {
            "ghcr.io/devcontainers/features/common-utils:2": {}
        },
        
        "customizations": {
            "vscode": {
                "extensions": [
                    "ritwickdey.liveserver", 
                    "astro-build.astro-vscode"
                ],
                "settings": {
                    "liveServer.settings.port": 8080,
                    "liveServer.settings.root": "/",
                    "editor.formatOnSave": true
                }
            }
        },
        
        "portsAttributes": portsAttributes,
        
        // Run once when the container is created
        "postCreateCommand": "npm install -g http-server live-server",
        
        // Run every time the user connects/attaches
        "postAttachCommand": attachCommand
    };

    // -- Terminal Panel Logic --
    // If 'terminal' is requested, we don't need extra JSON config; 
    // VS Code opens a terminal by default. 
    // However, we can use tasks.json if specific split panes are needed.

    fs.writeFileSync(
        path.join(devContainerDir, 'devcontainer.json'), 
        JSON.stringify(devContainerConfig, null, 4)
    );
    console.log(`✅ Generated devcontainer configuration in.devcontainer/${name}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
