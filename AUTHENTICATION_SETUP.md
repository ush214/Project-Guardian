# Project Guardian - Invite-Only Authentication Setup

## Overview

Project Guardian now uses invite-only authentication with email/password sign-in and an allowlist system for protected actions.

## User Management

### Creating Users in Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your Project Guardian project
3. Navigate to **Authentication** > **Users**
4. Click **Add user**
5. Enter the user's email and password
6. Save the user

### Adding Users to Allowlist

After creating a user in Firebase Authentication, you must add them to the allowlist:

1. Go to **Firestore Database** in Firebase Console
2. Navigate to the `system` collection
3. Create/navigate to the `allowlist` subcollection
4. Create/navigate to the `users` subcollection
5. Create a new document with the **User UID** as the document ID
6. The document can be empty (existence indicates permission)

**Document Path Format:**
```
system/allowlist/users/{USER_UID}
```

**Example:**
- Document ID: `abc123def456ghi789` (the user's UID from Authentication)
- Document data: `{}` (empty object is sufficient)

## Access Control

### Public Access (No Authentication Required)
- ✅ Reading assessments and maps
- ✅ Viewing existing reports
- ✅ Browsing environmental alerts

### Protected Access (Authentication + Allowlist Required)
- 🔒 Running new analyses (`runFullAnalysis`)
- 🔒 Enhancing existing reports (`enhanceAnalysis`)
- 🔒 All calls to `callGeminiApi` cloud function

### Sign-in Process
1. Users go to `/login.html`
2. Enter email and password (created by admin in Firebase Console)
3. Upon successful sign-in, redirected to main app
4. Sign-out button appears in header when authenticated

## Deployment Checklist

### Pre-deployment Setup
- [ ] Create user accounts in Firebase Console > Authentication
- [ ] Add corresponding allowlist documents in Firestore
- [ ] Disable any previously enabled OAuth providers (Google, Microsoft, GitHub)

### Deploy Commands
```bash
# Deploy everything
firebase deploy --only firestore:rules,hosting,functions

# Or deploy individually
firebase deploy --only firestore:rules
firebase deploy --only hosting  
firebase deploy --only functions
```

### Post-deployment Testing

#### Test with Allowlisted User
1. Sign in with an allowlisted user account
2. Try running a new analysis - should succeed
3. Try enhancing a report - should succeed
4. Sign out functionality should work

#### Test with Non-allowlisted User  
1. Create a user in Authentication but don't add to allowlist
2. Sign in with this account
3. Try running analysis - should fail with "permission-denied"
4. Verify cloud function returns proper error

#### Test Public Access
1. Visit app without signing in
2. Should be able to read existing assessments
3. Should be able to view maps and reports
4. Analysis buttons should prompt for sign-in

### Firebase Console Configuration

#### Disable OAuth Providers
1. Go to **Authentication** > **Sign-in method**
2. Disable any enabled providers:
   - Google
   - Microsoft  
   - GitHub
   - Any other OAuth providers
3. Ensure only **Email/Password** is enabled

#### Verify Firestore Rules
Check that rules are deployed correctly:
1. Go to **Firestore Database** > **Rules**
2. Verify the rules include allowlist checking
3. Test rules in the Rules Playground if needed

## Security Notes

- Users can only be created by admins via Firebase Console
- No self-service registration is available
- Allowlist is managed server-side only (no client access)
- All write operations require both authentication and allowlist membership
- Cloud functions enforce allowlist checks for API access

## Troubleshooting

### "Permission Denied" Errors
- Verify user exists in `system/allowlist/users/{uid}`
- Check that UID matches exactly between Authentication and Firestore
- Ensure Firestore rules are deployed correctly

### Sign-in Issues
- Verify Email/Password provider is enabled
- Check user exists in Firebase Authentication
- Verify no typos in email/password

### Function Call Failures
- Check user is signed in (not anonymous)
- Verify user is in allowlist
- Check browser console for detailed error messages