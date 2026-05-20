# Edge Agent Installer and Deployment Handbook
# Satisfies Requirement 15.5, 14.6

This handbook documents the installation, uninstallation, versioning, and signature verification procedures for the **Edge Agent**.

---

## 1. Installation Procedures

### Windows (MSI Installer)
The Windows Edge Agent is delivered as a cryptographically signed `.msi` package.
1. Download the latest release from the deployment portal.
2. Double-click the `.msi` file to launch the installation wizard.
3. Choose the installation path (default: `C:\Program Files\May\EdgeAgent`).
4. Select the tenant configuration file (`tenant_config.json`) when prompted.
5. Click **Install** to complete setup.

### macOS (DMG Package)
The macOS Edge Agent is delivered as a notarized `.dmg` package.
1. Download and open the `.dmg` container.
2. Drag the `May Edge Agent.app` into your `/Applications` directory.
3. Copy your tenant provisioning token into standard context directory `~/.may/config.json`.

### Linux (Debian / RPM)
For Debian-based systems:
```bash
sudo dpkg -i may-edge-agent_latest.deb
```
For RedHat-based systems:
```bash
sudo rpm -ivh may-edge-agent_latest.rpm
```

---

## 2. Uninstallation Procedures

### Windows
1. Open the **Control Panel** → **Programs and Features**.
2. Select **May Edge Agent** from the list.
3. Click **Uninstall**.
4. Confirm deletion of local cache and secure buffers if prompted.

### macOS
1. Open the `/Applications` folder.
2. Drag `May Edge Agent` to the **Trash**.
3. Run the cleanup script to remove residual tenant data:
```bash
rm -rf ~/.may/
```

### Linux
```bash
sudo apt-get purge may-edge-agent
# or
sudo yum remove may-edge-agent
```

---

## 3. Cryptographic Signature Verification
All release artifacts are signed using a Sigstore-compatible private key.
To verify an artifact's integrity and SLSA Level 3 provenance before admission:
```bash
cosign verify \
  --key cosign.pub \
  --certificate-identity "https://github.com/Sameer1551/AI-Assistant/.github/workflows/release.yml" \
  may-edge-agent-latest.deb
```

---

## 4. Independent Versioning Strategy
The Edge Agent operates under an independent semantic versioning scheme (e.g. `v1.2.0-edge`) separate from the core backend microservices. Compatibility matrix is declared in `packages/types/src/compatibility.ts` and validated at Edge Session Negotiation time.
