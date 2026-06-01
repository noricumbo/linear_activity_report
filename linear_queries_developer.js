import 'dotenv/config';
import { LinearClient } from '@linear/sdk';
import { hasMergedPR } from './team_issues_report.js';

// Load API key from environment variable
const apiKey = process.env.LINEAR_API_KEY;
const accessToken = process.env.LINEAR_ACCESS_TOKEN;

if (!apiKey && !accessToken) {
  throw new Error('Please set either LINEAR_API_KEY or LINEAR_ACCESS_TOKEN in your .env file');
}

// With Personal API Key or OAuth 2.0 Access Token
const linearClient = apiKey 
  ? new LinearClient({ apiKey })
  : new LinearClient({ accessToken });

/**
 * Normalize line terminators to standard \n
 * Replaces Unicode line separators (U+2028) and paragraph separators (U+2029)
 * with standard newline characters
 */
function normalizeLineTerminators(text) {
  if (!text) return text;
  return text
    .replace(/\u2028/g, '\n')  // Line Separator
    .replace(/\u2029/g, '\n')   // Paragraph Separator
    .replace(/\r\n/g, '\n')     // Windows line endings
    .replace(/\r/g, '\n');      // Old Mac line endings
}

/**
 * Get user activity including comments, reactions, and issue interactions
 * @param {string} userEmail - Email of the user to track
 * @param {Object} options - Optional filters
 * @param {Date} options.since - Only get activity since this date
 * @param {number} options.limit - Maximum number of results per query
 * @param {boolean} options.includeArchived - Linear `includeArchived` on issues and comments queries (default false)
 */
async function getUserActivity(userEmail, options = {}) {
  const { since, limit = 100, includeArchived = false } = options;
  
  try {
    // First, find the user by email (with pagination to get all users)
    const userSpinner = createSpinner('Searching for user');
    userSpinner.start();
    let user = null;
    let hasNextPage = true;
    let after = null;
    const allUsers = [];
    
    // Fetch all users with pagination
    while (hasNextPage) {
      const usersResponse = await linearClient.users({
        first: 50,
        ...(after && { after }),
      });
      
      allUsers.push(...usersResponse.nodes);
      hasNextPage = usersResponse.pageInfo.hasNextPage;
      after = usersResponse.pageInfo.endCursor;
    }
    
    userSpinner.stop();
    console.log(`   Found ${allUsers.length} users in workspace`);
    
    // Try to find user by email (case-insensitive)
    user = allUsers.find(u => 
      u.email && u.email.toLowerCase() === userEmail.toLowerCase()
    );
    
    // If not found by exact email, try partial match
    if (!user) {
      user = allUsers.find(u => 
        u.email && u.email.toLowerCase().includes(userEmail.toLowerCase())
      );
    }
    
    // Debug: show first few users if not found
    if (!user) {
      console.log('\n   Available users (first 10):');
      allUsers.slice(0, 10).forEach(u => {
        console.log(`   - ${u.name} (${u.email || 'no email'})`);
      });
      throw new Error(`User with email ${userEmail} not found. Found ${allUsers.length} users total.`);
    }
    
    console.log(`\n📊 Fetching activity for: ${user.name} (${user.email})\n`);
    
    const activity = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      comments: [],
      reactions: [],
      issueUpdates: [],
      issueCreations: [],
      issueAssignments: [],
      withMergedPRs: 0,
    };
    
    // Get all comments by this user
    const commentsSpinner = createSpinner('Fetching comments');
    commentsSpinner.start();
    const commentsFilter = {
      user: { id: { eq: user.id } },
    };
    if (since) {
      commentsFilter.createdAt = { gte: since };
    }
    
    const comments = await linearClient.comments({
      filter: commentsFilter,
      first: limit,
      ...(includeArchived && { includeArchived: true }),
    });
    
    for (const comment of comments.nodes) {
      const issue = await comment.issue;
      activity.comments.push({
        id: comment.id,
        body: normalizeLineTerminators(comment.body || ''),
        createdAt: comment.createdAt,
        issue: {
          id: issue?.id,
          title: issue?.title,
          identifier: issue?.identifier,
          url: issue?.url,
        },
      });
    }
    commentsSpinner.stop();
    console.log(`   Found ${comments.nodes.length} comment(s)`);
    
    // Get reactions by this user
    const reactionsSpinner = createSpinner('Fetching reactions');
    reactionsSpinner.start();
    let reactions = { nodes: [] };
    let reactionsByIssue = new Map();
    
    try {
      reactions = await linearClient.reactions({
        filter: {
          user: { id: { eq: user.id } },
          ...(since && { createdAt: { gte: since } }),
        },
        first: limit,
      });
      
      // Group reactions by issue
      for (const reaction of reactions.nodes) {
        const issue = await reaction.issue;
        if (issue) {
          if (!reactionsByIssue.has(issue.id)) {
            reactionsByIssue.set(issue.id, []);
          }
          reactionsByIssue.get(issue.id).push({
            emoji: reaction.emoji,
            createdAt: reaction.createdAt,
          });
          
          // Also add to reactions array
          activity.reactions.push({
            id: reaction.id,
            emoji: reaction.emoji,
            createdAt: reaction.createdAt,
            issue: {
              id: issue.id,
              title: issue.title,
              identifier: issue.identifier,
              url: issue.url,
            },
          });
        }
      }
      reactionsSpinner.stop();
    } catch (err) {
      reactionsSpinner.stop();
      console.warn('   Warning: Could not fetch reactions:', err.message);
      console.warn('   Reactions feature may not be available in your Linear workspace');
    }
    
    // Get issues where user has interacted (commented or reacted)
    const interactionsSpinner = createSpinner('Fetching issue interactions');
    interactionsSpinner.start();
    const issueIdsWithActivity = new Set();
    
    // Add issue IDs from comments
    activity.comments.forEach(comment => {
      if (comment.issue?.id) {
        issueIdsWithActivity.add(comment.issue.id);
      }
    });
    
    // Add issue IDs from reactions
    reactionsByIssue.forEach((_, issueId) => {
      issueIdsWithActivity.add(issueId);
    });
    
    // Fetch issue details for issues with activity
    for (const issueId of issueIdsWithActivity) {
      try {
        const issue = await linearClient.issue(issueId);
        if (issue) {
          const issueComments = activity.comments.filter(c => c.issue?.id === issueId);
          const issueReactions = reactionsByIssue.get(issueId) || [];
          
          activity.issueUpdates.push({
            issue: {
              id: issue.id,
              title: issue.title,
              identifier: issue.identifier,
              url: issue.url,
              state: (await issue.state)?.name,
            },
            comments: issueComments.map(c => ({
              id: c.id,
              body: c.body,
              createdAt: c.createdAt,
            })),
            reactions: issueReactions,
            lastUpdated: issue.updatedAt,
          });
        }
      } catch (err) {
        console.warn(`   Warning: Could not fetch issue ${issueId}:`, err.message);
      }
    }
    interactionsSpinner.stop();
    console.log(`   Found ${activity.issueUpdates.length} issue interaction(s)`);
    
    // Get issues assigned to user
    const assignedSpinner = createSpinner('Fetching issues assigned to user');
    assignedSpinner.start();
    const assignedFilter = {
      assignee: { id: { eq: user.id } },
    };
    if (since) {
      assignedFilter.updatedAt = { gte: since };
    }
    
    const assignedIssues = await linearClient.issues({
      filter: assignedFilter,
      first: limit,
      ...(includeArchived && { includeArchived: true }),
    });
    
    console.log(`   Found ${assignedIssues.nodes.length} assigned issue(s)`);
    
    for (const issue of assignedIssues.nodes) {
      const state = await issue.state;
      activity.issueAssignments.push({
        id: issue.id,
        title: issue.title,
        identifier: issue.identifier,
        url: issue.url,
        state: state?.name,
        updatedAt: issue.updatedAt,
        description: normalizeLineTerminators(issue.description || ''),
      });
    }
    assignedSpinner.stop();
    console.log(`   Found ${assignedIssues.nodes.length} assigned issue(s)`);
    
    // Get issues created by user
    const createdSpinner = createSpinner('Fetching issues created by user');
    createdSpinner.start();
    const createdFilter = {
      creator: { id: { eq: user.id } },
    };
    if (since) {
      createdFilter.updatedAt = { gte: since };
    }
    
    const createdIssues = await linearClient.issues({
      filter: createdFilter,
      first: limit,
      ...(includeArchived && { includeArchived: true }),
    });
    
    console.log(`   Found ${createdIssues.nodes.length} created issue(s)`);
    
    for (const issue of createdIssues.nodes) {
      activity.issueCreations.push({
        id: issue.id,
        title: issue.title,
        identifier: issue.identifier,
        url: issue.url,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        description: normalizeLineTerminators(issue.description || ''),
      });
    }
    createdSpinner.stop();
    console.log(`   Found ${createdIssues.nodes.length} created issue(s)`);
    
    const mergedSpinner = createSpinner('Checking issues for merged PRs');
    mergedSpinner.start();
    let mergedPRCount = 0;
    for (const issue of assignedIssues.nodes) {
      if (await hasMergedPR(issue)) {
        mergedPRCount++;
      }
    }
    const assignedIssueIds = new Set(assignedIssues.nodes.map((i) => i.id));
    for (const issue of createdIssues.nodes) {
      if (!assignedIssueIds.has(issue.id) && (await hasMergedPR(issue))) {
        mergedPRCount++;
      }
    }
    mergedSpinner.stop();
    console.log(`   Found ${mergedPRCount} issue(s) with merged PR(s) (assigned + created, deduplicated)`);
    activity.withMergedPRs = mergedPRCount;
    
    return activity;
  } catch (error) {
    console.error('Error fetching user activity:', error);
    throw error;
  }
}

/**
 * Display summary of user activity (minimal console output)
 */
function displaySummary(activity) {
  console.log('\n' + '='.repeat(80));
  console.log(`📊 ACTIVITY SUMMARY FOR ${activity.user.name.toUpperCase()}`);
  console.log('='.repeat(80));
  console.log(`\n   Total Comments: ${activity.comments.length}`);
  console.log(`   Issue Interactions: ${activity.issueUpdates.length}`);
  console.log(`   Issues Created: ${activity.issueCreations.length}`);
  console.log(`   Issues Assigned: ${activity.issueAssignments.length}`);
  console.log(`   Issues with merged PRs: ${activity.withMergedPRs}`);
  console.log('='.repeat(80) + '\n');
}

/**
 * Show loading spinner with timer
 */
function createSpinner(message) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  let startTime = Date.now();
  let intervalId = null;
  
  const update = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const frame = frames[frameIndex % frames.length];
    process.stdout.write(`\r${frame} ${message} (${elapsed}s)`);
    frameIndex++;
  };
  
  return {
    start: () => {
      startTime = Date.now();
      intervalId = setInterval(update, 100);
    },
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\r✅ ${message} completed in ${elapsed}s\n`);
    }
  };
}

/**
 * Format and display user activity in a readable way (for file export)
 * This function is kept for backward compatibility but doesn't output to console
 */
function displayActivity(activity) {
  // This function is now only used internally for generating text reports
  // Console output is handled by displaySummary()
  return generateTextReport(activity);
}

/**
 * Generate formatted text report
 */
function generateTextReport(activity) {
  let report = '\n' + '='.repeat(80) + '\n';
  report += `📈 ACTIVITY REPORT FOR ${activity.user.name.toUpperCase()}\n`;
  report += '='.repeat(80) + '\n';
  
  report += `\n📝 COMMENTS (${activity.comments.length}):\n`;
  if (activity.comments.length === 0) {
    report += '   No comments found\n';
  } else {
    activity.comments.forEach((comment, idx) => {
      report += `\n   ${idx + 1}. Issue: ${comment.issue.identifier} - ${comment.issue.title}\n`;
      report += `      Date: ${new Date(comment.createdAt).toLocaleString()}\n`;
      report += `      URL: ${comment.issue.url}\n`;
      report += `      Comment:\n`;
      // Indent the comment body for better readability
      const normalizedBody = normalizeLineTerminators(comment.body);
      const commentLines = normalizedBody.split('\n');
      commentLines.forEach(line => {
        report += `         ${line}\n`;
      });
    });
  }
  
  report += `\n💬 ISSUE INTERACTIONS (${activity.issueUpdates.length}):\n`;
  if (activity.issueUpdates.length === 0) {
    report += '   No issue interactions found\n';
  } else {
    activity.issueUpdates.forEach((interaction, idx) => {
      report += `\n   ${idx + 1}. Issue: ${interaction.issue.identifier} - ${interaction.issue.title}\n`;
      report += `      State: ${interaction.issue.state}\n`;
      report += `      Comments: ${interaction.comments.length}\n`;
      report += `      Reactions: ${interaction.reactions.length}\n`;
      if (interaction.reactions.length > 0) {
        report += `      Reaction emojis: ${interaction.reactions.map(r => r.emoji).join(', ')}\n`;
      }
      report += `      Last Updated: ${new Date(interaction.lastUpdated).toLocaleString()}\n`;
      report += `      URL: ${interaction.issue.url}\n`;
    });
  }
  
  report += `\n✨ ISSUES CREATED (${activity.issueCreations.length}):\n`;
  if (activity.issueCreations.length === 0) {
    report += '   No issues created\n';
  } else {
    activity.issueCreations.forEach((issue, idx) => {
      report += `\n   ${idx + 1}. ${issue.identifier} - ${issue.title}\n`;
      report += `      Created: ${new Date(issue.createdAt).toLocaleString()}\n`;
      if (issue.description) {
        report += `      Description:\n`;
        const normalizedDesc = normalizeLineTerminators(issue.description);
        const descLines = normalizedDesc.split('\n');
        descLines.forEach(line => {
          report += `         ${line}\n`;
        });
      }
    });
  }
  
  report += `\n📋 ISSUES ASSIGNED (${activity.issueAssignments.length}):\n`;
  if (activity.issueAssignments.length === 0) {
    report += '   No issues assigned\n';
  } else {
    activity.issueAssignments.forEach((issue, idx) => {
      report += `\n   ${idx + 1}. ${issue.identifier} - ${issue.title} [${issue.state}]\n`;
      if (issue.updatedAt) {
        report += `      Updated: ${new Date(issue.updatedAt).toLocaleString()}\n`;
      }
      if (issue.description) {
        report += `      Description:\n`;
        const normalizedDesc = normalizeLineTerminators(issue.description);
        const descLines = normalizedDesc.split('\n');
        descLines.forEach(line => {
          report += `         ${line}\n`;
        });
      }
    });
  }
  
  report += '\n' + '='.repeat(80) + '\n';
  report += '\n📊 SUMMARY:\n';
  report += `   Total Comments: ${activity.comments.length}\n`;
  report += `   Issue Interactions: ${activity.issueUpdates.length}\n`;
  report += `   Issues Created: ${activity.issueCreations.length}\n`;
  report += `   Issues Assigned: ${activity.issueAssignments.length}\n`;
  report += `   Issues with merged PRs: ${activity.withMergedPRs}\n`;
  report += '='.repeat(80) + '\n';
  
  return report;
}

/**
 * Export activity to text file
 */
async function exportActivityToText(activity, filename = null) {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  // Create reports directory if it doesn't exist
  const reportsDir = 'reports';
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (err) {
    // Directory might already exist, that's fine
  }
  
  if (!filename) {
    // Generate filename based on user and date
    const userSlug = activity.user.email.split('@')[0].replace(/[^a-z0-9]/gi, '_');
    const dateStr = new Date().toISOString().split('T')[0];
    filename = `activity_report_${userSlug}_${dateStr}.txt`;
  }
  
  // Ensure filename is in the reports directory
  const filepath = path.join(reportsDir, filename);
  
  const report = generateTextReport(activity);
  await fs.writeFile(filepath, report, 'utf8');
  return filepath;
}

/**
 * Export activity to JSON file
 */
async function exportActivityToJSON(activity, filename = null) {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  // Create reports directory if it doesn't exist
  const reportsDir = 'reports';
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (err) {
    // Directory might already exist, that's fine
  }
  
  if (!filename) {
    // Generate filename based on user and date
    const userSlug = activity.user.email.split('@')[0].replace(/[^a-z0-9]/gi, '_');
    const dateStr = new Date().toISOString().split('T')[0];
    filename = `activity_report_${userSlug}_${dateStr}.json`;
  }
  
  // Ensure filename is in the reports directory
  const filepath = path.join(reportsDir, filename);
  
  await fs.writeFile(filepath, JSON.stringify(activity, null, 2), 'utf8');
  return filepath;
}

// Main execution
async function main() {
  // Get user email from command line or environment variable
  const userEmail = process.argv[2] || process.env.USER_EMAIL;
  
  if (!userEmail) {
    console.error('❌ Please provide a user email as an argument:');
    console.error('   node linear_queries.js user@example.com');
    console.error('\n   Or set USER_EMAIL in your .env file');
    process.exit(1);
  }
  
  // Optional: Get activity since a specific date (e.g., last 30 days)
  // Pass 0 or "all" to get all activity
  const daysBackArg = process.argv[3];
  let daysBack = 30;
  let since = null;
  
  if (daysBackArg) {
    if (daysBackArg.toLowerCase() === 'all' || daysBackArg === '0') {
      daysBack = null;
      console.log('📅 Fetching ALL activity (no date filter)\n');
    } else {
      daysBack = parseInt(daysBackArg);
      if (isNaN(daysBack)) {
        console.error(`❌ Invalid days argument: ${daysBackArg}. Use a number or "all"`);
        process.exit(1);
      }
      since = new Date();
      since.setDate(since.getDate() - daysBack);
      console.log(`📅 Fetching activity from the last ${daysBack} days (since ${since.toLocaleDateString()})\n`);
    }
  } else {
    since = new Date();
    since.setDate(since.getDate() - daysBack);
    console.log(`📅 Fetching activity from the last ${daysBack} days (since ${since.toLocaleDateString()})\n`);
  }
  
  const includeArchived =
    process.env.INCLUDE_ARCHIVED_ISSUES === '1' ||
    process.env.INCLUDE_ARCHIVED_ISSUES === 'true' ||
    process.argv.includes('--include-archived');
  if (includeArchived) {
    console.log('📦 Including archived issues in issues & comments queries (Linear includeArchived)\n');
  }

  try {
    const activity = await getUserActivity(userEmail, { since, limit: 100, includeArchived });
    
    // Check if we got zero results but there might be activity outside the date range
    const totalActivity = activity.comments.length + activity.issueUpdates.length + 
                         activity.issueCreations.length + activity.issueAssignments.length;
    
    if (totalActivity === 0 && since) {
      console.log('\n⚠️  No activity found in the specified date range.');
      console.log('   Try running without a date filter to see all activity:');
      console.log(`   node linear_queries.js ${userEmail} all\n`);
    }
    
    // Show summary in console
    displaySummary(activity);
    
    // Show loading spinner while generating and saving report
    const spinner = createSpinner('Generating report');
    spinner.start();
    
    try {
      // Automatically save text report to file
      const reportFile = await exportActivityToText(activity);
      
      // Optionally export to JSON
      let jsonFile = null;
      if (process.argv.includes('--export') || process.argv.includes('--json')) {
        jsonFile = await exportActivityToJSON(activity);
      }
      
      spinner.stop();
      console.log(`\n✅ Report saved to: ${reportFile}`);
      if (jsonFile) {
        console.log(`✅ JSON exported to: ${jsonFile}`);
      }
      console.log('');
    } catch (err) {
      spinner.stop();
      throw err;
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if this file is executed directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     process.argv[1]?.endsWith('linear_queries.js');
if (isMainModule) {
  main();
}

export { getUserActivity, displayActivity, displaySummary, exportActivityToJSON, exportActivityToText, generateTextReport };