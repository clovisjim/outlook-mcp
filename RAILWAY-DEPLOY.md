# Deploying Outlook MCP Server on Railway

This guide provides step-by-step instructions for deploying the Outlook MCP server to [Railway](https://railway.app) as a cloud-hosted service. This setup uses a Docker container, a PostgreSQL database for secure token storage, and an HTTP/SSE transport layer, making it accessible from any MCP client over the internet.

## Architecture Overview

- **Hosting**: Railway (serverless platform)
- **Transport**: HTTP/SSE (replaces the local `stdio` transport)
- **Database**: PostgreSQL (provided by Railway) for storing OAuth tokens.
- **Security**: OAuth tokens are encrypted at rest in the database using AES-256-GCM.
- **Deployment**: Automatic builds and deployments from your GitHub repository via a `Dockerfile`.

---

## 1. Prerequisites

Before you begin, ensure you have:

1.  **GitHub Account**: Where you have forked this repository.
2.  **Railway Account**: To host the server and database.
3.  **Microsoft Azure Account**: To create an App Registration for OAuth 2.0 credentials.

---

## 2. Railway Project Setup

1.  **Create a New Project**: Log in to your Railway dashboard and click "New Project".
2.  **Deploy from GitHub Repo**: Select "Deploy from GitHub repo" and choose your forked `outlook-mcp` repository.
3.  **Add a Database**: Once the service is created, go to the project dashboard, click "New", and select "Database" > "Add PostgreSQL". Railway will automatically provision a database and link it to your service.

Railway will now detect the `Dockerfile` and attempt to build and deploy your service. It may fail initially because the required environment variables are not yet set. Proceed to the next steps.

---

## 3. Azure AD App Registration

This server needs Microsoft Graph API credentials to function. You must create an App Registration in the Azure portal.

1.  **Navigate to App Registrations**: Go to the [Azure Portal](https://portal.azure.com/) and search for "App registrations".
2.  **New Registration**:
    -   Click "New registration".
    -   Give it a name (e.g., `My-Outlook-MCP-Server`).
    -   For "Supported account types", select **"Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)"**. This is crucial for allowing personal Outlook.com accounts.
3.  **Add Redirect URI**:
    -   After creating the app, go to the **Authentication** tab.
    -   Click "Add a platform" and select **"Web"**.
    -   You will need your Railway app's public URL. Find this in your Railway project dashboard under your service's **Settings** tab (it looks like `https://<your-app-name>.up.railway.app`).
    -   In the "Redirect URIs" field, enter:
        ```
        https://<your-app-name>.up.railway.app/auth/callback
        ```
    -   Click "Configure".
4.  **Create a Client Secret**:
    -   Go to the **Certificates & secrets** tab.
    -   Click "New client secret".
    -   Give it a description and an expiry duration.
    -   **IMPORTANT**: Copy the secret **Value** immediately and save it. You will not be able to see it again.
5.  **Gather Credentials**:
    -   From the **Overview** tab, copy the **Application (client) ID**.

You now have the `MS_CLIENT_ID` and `MS_CLIENT_SECRET` needed for the next step.

---

## 4. Configure Environment Variables in Railway

In your Railway project, go to your service's **Variables** tab and add the following secrets. Railway automatically provides `DATABASE_URL` and `PORT`.

| Variable                 | Description                                                                                                                                    | Example Value                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `MS_CLIENT_ID`           | The Application (client) ID from your Azure App Registration.                                                                                  | `a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6`                        |
| `MS_CLIENT_SECRET`       | The client secret **Value** you created in Azure.                                                                                              | `XyZ~abc.123_ABC-defGHIjklmnoPQR`                              |
| `BASE_URL`               | The public URL of your Railway app. Find this in **Settings** > **Domains**. **Do not add a trailing slash.**                                      | `https://outlook-mcp-prod.up.railway.app`                     |
| `TOKEN_ENCRYPTION_KEY`   | A 64-character hex string (32 bytes) used to encrypt tokens in the database. Generate one locally by running `npm run generate-key`.           | `f0e1d2c3b4a5968778695a4b3c2d1e0f...` (must be 64 chars) |

After adding these variables, Railway will automatically trigger a new deployment. The build should now succeed.

---

## 5. Initial Authentication

Once deployed, you must perform the first OAuth authentication to grant the server access to your Outlook data.

1.  Open your browser and navigate to your app's public URL (your `BASE_URL`).
2.  You will see a status page. Click the link for `GET /auth` or manually navigate to `https://<your-app-name>.up.railway.app/auth`.
3.  This will redirect you to the Microsoft login page. Sign in with the Outlook account you want the MCP server to access.
4.  Grant the requested permissions.
5.  You will be redirected back to a success page on your Railway app.

Your tokens are now securely stored and encrypted in the PostgreSQL database, and the server is ready to accept MCP client connections.

---

## 6. Connecting Your MCP Client

To connect an MCP client (like the MCP Inspector or a tool-enabled LLM), use the server's SSE endpoint:

```
https://<your-app-name>.up.railway.app/sse
```

---

## 7. Troubleshooting

-   **502 Bad Gateway**: Check the service logs in Railway. This often indicates a startup crash. Common causes include missing environment variables or a database connection issue.
-   **Authentication Error on Callback**: Double-check that the `Redirect URI` in the Azure portal **exactly** matches `${BASE_URL}/auth/callback`.
-   **`invalid_client` Error**: This means your `MS_CLIENT_ID` or `MS_CLIENT_SECRET` is incorrect.
-   **Token Encryption Key Error**: Ensure `TOKEN_ENCRYPTION_KEY` is exactly 64 hexadecimal characters long.
