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
    // console.log('files[0]: ',files[0])
    // Process the first found zip file
    const zipFilename = files[0];
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

    // Locate Project Root & Check package.json
    // Sometimes zips contain a root folder (e.g. my-app/package.json) instead of files at root.
    let projectRoot = targetDir;
    
    // Check if package.json exists at extraction root
    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
        // If not, check if there is a single subdirectory containing it
        const subdirs = fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isDirectory());
        if (subdirs.length === 1) {
            projectRoot = path.join(targetDir, subdirs);
            console.log(`ℹ️  Found project in subdirectory: ${subdirs}`);
        }
    }

    // Explicit Check
    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
        console.error("❌ Error: package.json not found. Is this a valid Node.js project?");
        // Exit with error to fail the GitHub Action
        process.exit(1);
    }
    // 3. Load Tutorial Configuration
    const configPath = path.join(targetDir, 'tutorial-config.json');
    if (!fs.existsSync(configPath)) {
        console.error("❌ Error: tutorial-config.json not found in zip root.");
        throw new Error("tutorial-config.json missing in zip!");
        process.exit(1);
    }
    const tutorialConfig = fs.readJsonSync(configPath);

    // We add http-server and live-server to package.json here.
    // This allows 'npm install' to handle them efficiently in the container.
    const packageJsonPath = path.join(targetDir, 'package.json');

    // We construct the start command based on whether the browser panel is needed
    let startCommand = "http-server steps -p 3000 --cors -c-1 &";
    if (tutorialConfig.panels && tutorialConfig.panels.includes('browser')) {
        // We add the public port command here inside the package.json script
        // Note: We use 'wait' at the end to keep the process alive
        startCommand += " live-server --port=8080 --no-browser &";
        // 2. Add a 'sleep' so this message prints AFTER the server startup logs
        // 3. Print the clickable URL using the $CODESPACE_NAME variable
        // Note: We escape the $ so it is written literally into package.json
        const linkMsg = "echo \"\\n\\n--------------------------------------------------\\nYOUR APP IS READY:\\nhttps://\${CODESPACE_NAME}-8080.app.github.dev\\n--------------------------------------------------\\n\\n\"";
        startCommand += ` sleep 3 && ${linkMsg} & wait`;
    } else {
        startCommand += " wait";
    }
    
    if (fs.existsSync(packageJsonPath)) {
        const pkg = fs.readJsonSync(packageJsonPath);
        pkg.devDependencies = pkg.devDependencies || {};
        pkg.devDependencies["http-server"] = "^14.1.1";
        pkg.devDependencies["live-server"] = "^1.2.2";

        pkg.scripts = pkg.scripts || {};
        pkg.scripts["start"] = startCommand;
        
        fs.writeJsonSync(packageJsonPath, pkg, { spaces: 2 });
        console.log("📦 Injected dev dependencies into package.json");
    }

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

    // 5b. Generate tasks.json
    // This creates the VS Code task to run 'npm start' automatically
    generateTasksJson(targetDir);
    
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

function generateTasksJson(targetDir) {
    const vscodeDir = path.join(targetDir, '.vscode');
    fs.ensureDirSync(vscodeDir);

    const tasksConfig = {
        "version": "2.0.0",
        "tasks": [
            {
                "label": "Start Tutorial Environment",
                "type": "npm",
                "script": "start", // Runs the 'npm start' script we injected earlier
                "isBackground": true, // Keeps it running in background but visible in terminal
                "problemMatcher": {
                    "owner": "custom",
                    "pattern": {
                        "regexp": "^$"
                    },
                    "background": {
                        "activeOnStart": true,
                        "beginsPattern": "Starting up",
                        "endsPattern": "Available on"
                    }
                },
                "presentation": {
                    "reveal": "always",
                    "panel": "dedicated",
                    "group": "terminals"
                },
                "runOptions": {
                    "runOn": "folderOpen" // This makes it start automatically!
                }
            }
        ]
    };

    fs.writeFileSync(
        path.join(vscodeDir, 'tasks.json'),
        JSON.stringify(tasksConfig, null, 4)
    );
    console.log("✅ Generated .vscode/tasks.json");
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
            "onAutoForward": "notify",
            "visibility": "public"
        };
    }

    // -- Startup Commands --
    // 1. Serve the 'steps' folder (static site) on port 3000
    // 2. Serve the current directory on port 8080 (if browser requested)
    // We use 'concurrently' or simple background '&' operators.
    
    // let attachCommand = "nohup npx http-server steps -p 3000 --cors -c-1 > /dev/null 2>&1 &";
    
    // if (config.panels && config.panels.includes('browser')) {
    //     // live-server provides hot reload for the user's index.html
    //     attachCommand += " nohup npx live-server --port=8080 --no-browser > /dev/null 2>&1 &";
    // }

    // -- The DevContainer Configuration Object --
    const devContainerConfig = {
        "name": `Tutorial: ${name}`,
        "image": "mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm",
        
        // Isolate the user in the specific tutorial folder
        "workspaceFolder": `/workspaces/${REPO_NAME}/tutorials/${name}`,

        "waitFor": "onCreateCommand",

        "updateContentCommand": "npm install",

        // Run once when the container is created
        "postCreateCommand": "",
        
        // Run every time the user connects/attaches
        "postAttachCommand": "npm start",

        "features": {},
        
        "customizations": {
            "vscode": {
                "extensions": [],
                "settings": {
                    "editor.formatOnSave": true
                }
            },
            "codespaces": {
                "openFiles": config.files || []
            }
        },
        
        "portsAttributes": portsAttributes,
        
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
