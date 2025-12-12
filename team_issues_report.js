import 'dotenv/config';
import { LinearClient } from '@linear/sdk';
import fs from 'fs/promises';
import path from 'path';

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
 * Get all users from Linear workspace
 */
async function getAllUsers() {
  const spinner = createSpinner('Fetching all users');
  spinner.start();
  
  let hasNextPage = true;
  let after = null;
  const allUsers = [];
  
  while (hasNextPage) {
    const usersResponse = await linearClient.users({
      first: 50,
      ...(after && { after }),
    });
    
    allUsers.push(...usersResponse.nodes);
    hasNextPage = usersResponse.pageInfo.hasNextPage;
    after = usersResponse.pageInfo.endCursor;
  }
  
  spinner.stop();
  console.log(`   Found ${allUsers.length} users in workspace\n`);
  
  return allUsers;
}

/**
 * Find users by email addresses
 */
function findUsersByEmails(allUsers, emails) {
  const foundUsers = [];
  const notFound = [];
  
  for (const email of emails) {
    const user = allUsers.find(u => 
      u.email && u.email.toLowerCase() === email.toLowerCase()
    );
    
    if (user) {
      foundUsers.push(user);
    } else {
      // Try partial match
      const partialMatch = allUsers.find(u => 
        u.email && u.email.toLowerCase().includes(email.toLowerCase())
      );
      
      if (partialMatch) {
        foundUsers.push(partialMatch);
      } else {
        notFound.push(email);
      }
    }
  }
  
  if (notFound.length > 0) {
    console.warn(`\n⚠️  Warning: Could not find users with emails:`);
    notFound.forEach(email => console.warn(`   - ${email}`));
    console.warn('');
  }
  
  return foundUsers;
}

/**
 * Check if an issue has at least one merged PR
 * 
 * Detection method:
 * 1. Checks issue attachments (created by GitHub/GitLab integration when PRs are linked)
 * 2. Looks for PR attachments by checking URL patterns (/pull/, /merge_requests/)
 * 3. Checks attachment metadata for merged status (metadata.state, metadata.merged, metadata.status)
 * 4. Fallback: If metadata unavailable, uses heuristic - checks if issue is "Done"/"Completed"/"Merged" AND has PR attachment
 * 
 * NOTE: This does NOT use:
 * - Issue labels (we could add support for a "merged" label if you use one)
 * - Issue status alone (only as fallback heuristic)
 * 
 * To debug what metadata is available, set DEBUG_PR_METADATA=true in .env
 */
async function hasMergedPR(issue) {
  try {
    // Get attachments for the issue
    const attachments = await issue.attachments();
    
    if (!attachments || attachments.nodes.length === 0) {
      return false;
    }
    
    const debugMode = process.env.DEBUG_PR_METADATA === 'true';
    
    // Check each attachment to see if it's a merged PR
    for (const attachment of attachments.nodes) {
      try {
        // Linear attachments for PRs typically have a subtype or metadata
        // Check if it's a pull request attachment
        const attachmentData = await attachment;
        
        if (!attachmentData) {
          continue;
        }
        
        // PR attachments in Linear usually have metadata indicating they're PRs
        // and we can check if they're merged through the metadata
        const metadata = attachmentData.metadata;
        const url = attachmentData.url || '';
        const subtitle = attachmentData.subtitle || '';
        const title = attachmentData.title || '';
        const subtype = attachmentData.subtype || '';
        
        // Debug: Log attachment info if debug mode is enabled
        if (debugMode) {
          console.log(`\n[DEBUG] Checking attachment for issue ${issue.identifier}:`);
          console.log(`  URL: ${url}`);
          console.log(`  Title: ${title}`);
          console.log(`  Subtitle: ${subtitle}`);
          console.log(`  Subtype: ${subtype}`);
          console.log(`  Metadata:`, JSON.stringify(metadata, null, 2));
        }
        
        // Check if this is a PR attachment (GitHub/GitLab integration)
        // PR URLs typically contain 'pull' or 'merge_requests'
        const isPR = url.includes('/pull/') || 
                    url.includes('/merge_requests/') ||
                    url.includes('/pulls/') ||
                    subtitle.toLowerCase().includes('pull request') ||
                    subtitle.toLowerCase().includes('merge request') ||
                    title.toLowerCase().includes('pull request') ||
                    title.toLowerCase().includes('merge request') ||
                    subtype?.toLowerCase().includes('pull') ||
                    subtype?.toLowerCase().includes('merge');
        
        if (!isPR) {
          if (debugMode) {
            console.log(`  → Not a PR attachment, skipping`);
          }
          continue;
        }
        
        if (debugMode) {
          console.log(`  → This is a PR attachment!`);
        }
        
        // For GitHub: metadata might contain PR info with merged status
        // For GitLab: similar structure
        if (metadata) {
          // Check if it's merged
          // The exact structure depends on the integration, but typically:
          // - metadata.state === 'merged' (GitHub/GitLab)
          // - metadata.merged === true (GitHub)
          // - metadata.status === 'merged' (some integrations)
          const isMerged = metadata.state === 'merged' || 
                          metadata.merged === true || 
                          metadata.status === 'merged';
          
          if (debugMode) {
            console.log(`  → Merged status from metadata: ${isMerged}`);
          }
          
          if (isMerged) {
            return true;
          }
        } else if (debugMode) {
          console.log(`  → No metadata available, trying fallback`);
        }
        
        // Fallback: If we can't determine merged status from metadata,
        // check if the issue is in a "Done" state and has a PR attachment
        // This is a heuristic - if issue is done and has PR, likely merged
        const state = await issue.state;
        const isDoneState = state && (state.name === 'Done' || state.name === 'Completed' || state.name === 'Merged');
        
        if (debugMode) {
          console.log(`  → Issue state: ${state?.name || 'unknown'}`);
          console.log(`  → Using fallback heuristic: ${isDoneState ? 'LIKELY MERGED' : 'NOT MERGED'}`);
        }
        
        if (isDoneState) {
          return true;
        }
      } catch (attachmentError) {
        // Skip this attachment if there's an error
        if (process.env.DEBUG_PR_METADATA === 'true') {
          console.error(`  → Error checking attachment:`, attachmentError.message);
        }
        continue;
      }
    }
    
    return false;
  } catch (error) {
    // If we can't check attachments, return false
    // This might happen if attachments aren't accessible or integration isn't set up
    if (process.env.DEBUG_PR_METADATA === 'true') {
      console.error(`[DEBUG] Error in hasMergedPR:`, error.message);
    }
    return false;
  }
}

/**
 * Get issue statistics for a user
 */
async function getUserIssueStats(user, options = {}) {
  const { since, until, limit = 250 } = options;
  
  const stats = {
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    assigned: 0,
    created: 0,
    withMergedPRs: 0,
    totalHandled: 0,
  };
  
  // Get issues assigned to user
  const assignedFilter = {
    assignee: { id: { eq: user.id } },
  };
  if (since) {
    assignedFilter.updatedAt = { gte: since };
  }
  if (until) {
    if (assignedFilter.updatedAt) {
      assignedFilter.updatedAt = { ...assignedFilter.updatedAt, lte: until };
    } else {
      assignedFilter.updatedAt = { lte: until };
    }
  }
  
  let hasNextPage = true;
  let after = null;
  let assignedCount = 0;
  let assignedIssuesList = []; // Store issues to check for PRs
  
  while (hasNextPage) {
    const assignedIssues = await linearClient.issues({
      filter: assignedFilter,
      first: limit,
      ...(after && { after }),
    });
    
    assignedCount += assignedIssues.nodes.length;
    assignedIssuesList.push(...assignedIssues.nodes);
    hasNextPage = assignedIssues.pageInfo.hasNextPage;
    after = assignedIssues.pageInfo.endCursor;
    
    // Safety check to avoid infinite loops
    if (assignedIssues.nodes.length === 0) break;
  }
  
  stats.assigned = assignedCount;
  
  // Check assigned issues for merged PRs
  let mergedPRCount = 0;
  for (const issue of assignedIssuesList) {
    if (await hasMergedPR(issue)) {
      mergedPRCount++;
    }
  }
  
  // Get issues created by user
  const createdFilter = {
    creator: { id: { eq: user.id } },
  };
  if (since) {
    createdFilter.createdAt = { gte: since };
  }
  if (until) {
    if (createdFilter.createdAt) {
      createdFilter.createdAt = { ...createdFilter.createdAt, lte: until };
    } else {
      createdFilter.createdAt = { lte: until };
    }
  }
  
  hasNextPage = true;
  after = null;
  let createdCount = 0;
  let createdIssuesList = []; // Store issues to check for PRs
  
  while (hasNextPage) {
    const createdIssues = await linearClient.issues({
      filter: createdFilter,
      first: limit,
      ...(after && { after }),
    });
    
    createdCount += createdIssues.nodes.length;
    createdIssuesList.push(...createdIssues.nodes);
    hasNextPage = createdIssues.pageInfo.hasNextPage;
    after = createdIssues.pageInfo.endCursor;
    
    // Safety check to avoid infinite loops
    if (createdIssues.nodes.length === 0) break;
  }
  
  stats.created = createdCount;
  
  // Check created issues for merged PRs (avoid double counting if same issue)
  const checkedIssueIds = new Set(assignedIssuesList.map(i => i.id));
  for (const issue of createdIssuesList) {
    if (!checkedIssueIds.has(issue.id)) {
      if (await hasMergedPR(issue)) {
        mergedPRCount++;
      }
    }
  }
  
  stats.withMergedPRs = mergedPRCount;
  
  // Total handled = assigned + created (we'll deduplicate if needed)
  // For now, we'll count them separately and show both
  stats.totalHandled = stats.assigned + stats.created;
  
  return stats;
}

/**
 * Generate team issues report
 */
async function generateTeamIssuesReport(teamEmails = null, options = {}) {
  const { since, until, limit = 250, monthName } = options;
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 TEAM ISSUES REPORT');
  console.log('='.repeat(80));
  
  if (monthName) {
    console.log(`📅 Date Range: ${monthName}\n`);
  } else if (since && until) {
    console.log(`📅 Date Range: ${since.toLocaleDateString()} to ${until.toLocaleDateString()}\n`);
  } else if (since) {
    console.log(`📅 Date Range: Since ${since.toLocaleDateString()}\n`);
  } else {
    console.log('📅 Date Range: All time\n');
  }
  
  // Get all users
  const allUsers = await getAllUsers();
  
  // Determine which users to report on
  let targetUsers = [];
  
  if (teamEmails && teamEmails.length > 0) {
    console.log(`👥 Finding team members from provided emails...\n`);
    targetUsers = findUsersByEmails(allUsers, teamEmails);
  } else {
    console.log(`👥 Using all users in workspace...\n`);
    targetUsers = allUsers;
  }
  
  if (targetUsers.length === 0) {
    console.error('❌ No users found to generate report for');
    return null;
  }
  
  console.log(`📈 Generating report for ${targetUsers.length} developer(s)...\n`);
  
  // Get stats for each user
  const teamStats = [];
  
  for (let i = 0; i < targetUsers.length; i++) {
    const user = targetUsers[i];
    const spinner = createSpinner(`Processing ${user.name} (${i + 1}/${targetUsers.length})`);
    spinner.start();
    
    try {
      const stats = await getUserIssueStats(user, { since, until, limit });
      teamStats.push(stats);
      spinner.stop();
    } catch (error) {
      spinner.stop();
      console.error(`\n❌ Error processing ${user.name}: ${error.message}`);
      // Continue with other users
    }
  }
  
  // Sort by total handled (descending)
  teamStats.sort((a, b) => b.totalHandled - a.totalHandled);
  
  return {
    generatedAt: new Date().toISOString(),
    dateRange: {
      since: since ? since.toISOString() : null,
      until: until ? until.toISOString() : null,
      monthName: monthName || null,
    },
    teamStats,
    summary: {
      totalDevelopers: teamStats.length,
      totalIssuesAssigned: teamStats.reduce((sum, s) => sum + s.assigned, 0),
      totalIssuesCreated: teamStats.reduce((sum, s) => sum + s.created, 0),
      totalIssuesWithMergedPRs: teamStats.reduce((sum, s) => sum + s.withMergedPRs, 0),
      totalIssuesHandled: teamStats.reduce((sum, s) => sum + s.totalHandled, 0),
    },
  };
}

/**
 * Display report in console
 */
function displayReport(report) {
  if (!report) return;
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 TEAM ISSUES REPORT');
  console.log('='.repeat(80));
  console.log(`Generated: ${new Date(report.generatedAt).toLocaleString()}`);
  if (report.dateRange.monthName) {
    console.log(`Date Range: ${report.dateRange.monthName}`);
  } else if (report.dateRange.since && report.dateRange.until) {
    console.log(`Date Range: ${new Date(report.dateRange.since).toLocaleDateString()} to ${new Date(report.dateRange.until).toLocaleDateString()}`);
  } else if (report.dateRange.since) {
    console.log(`Date Range: Since ${new Date(report.dateRange.since).toLocaleDateString()}`);
  } else {
    console.log('Date Range: All time');
  }
  console.log('='.repeat(80) + '\n');
  
  // Display summary
  console.log('📈 SUMMARY:');
  console.log(`   Total Developers: ${report.summary.totalDevelopers}`);
  console.log(`   Total Issues Assigned: ${report.summary.totalIssuesAssigned}`);
  console.log(`   Total Issues Created: ${report.summary.totalIssuesCreated}`);
  console.log(`   Total Issues with Merged PRs: ${report.summary.totalIssuesWithMergedPRs}`);
  console.log(`   Total Issues Handled: ${report.summary.totalIssuesHandled}`);
  console.log('');
  
  // Display per-developer stats
  console.log('👥 DEVELOPER STATISTICS:\n');
  
  if (report.teamStats.length === 0) {
    console.log('   No data found for the specified criteria.\n');
    return;
  }
  
  // Calculate column widths for formatting
  const maxNameLength = Math.max(
    ...report.teamStats.map(s => s.userName.length),
    'Developer Name'.length
  );
  
  // Header
  console.log('   ' + 
    'Developer Name'.padEnd(maxNameLength + 2) + 
    'Assigned'.padStart(12) + 
    'Created'.padStart(12) + 
    'Merged PRs'.padStart(12) + 
    'Total'.padStart(12)
  );
  console.log('   ' + '-'.repeat(maxNameLength + 2 + 12 + 12 + 12 + 12));
  
  // Data rows
  report.teamStats.forEach(stats => {
    console.log('   ' + 
      stats.userName.padEnd(maxNameLength + 2) + 
      stats.assigned.toString().padStart(12) + 
      stats.created.toString().padStart(12) + 
      stats.withMergedPRs.toString().padStart(12) + 
      stats.totalHandled.toString().padStart(12)
    );
  });
  
  console.log('\n' + '='.repeat(80) + '\n');
}

/**
 * Generate text report
 */
function generateTextReport(report) {
  if (!report) return '';
  
  let text = '\n' + '='.repeat(80) + '\n';
  text += '📊 TEAM ISSUES REPORT\n';
  text += '='.repeat(80) + '\n';
  text += `Generated: ${new Date(report.generatedAt).toLocaleString()}\n`;
  if (report.dateRange.monthName) {
    text += `Date Range: ${report.dateRange.monthName}\n`;
  } else if (report.dateRange.since && report.dateRange.until) {
    text += `Date Range: ${new Date(report.dateRange.since).toLocaleDateString()} to ${new Date(report.dateRange.until).toLocaleDateString()}\n`;
  } else if (report.dateRange.since) {
    text += `Date Range: Since ${new Date(report.dateRange.since).toLocaleDateString()}\n`;
  } else {
    text += 'Date Range: All time\n';
  }
  text += '='.repeat(80) + '\n\n';
  
  // Summary
  text += '📈 SUMMARY:\n';
  text += `   Total Developers: ${report.summary.totalDevelopers}\n`;
  text += `   Total Issues Assigned: ${report.summary.totalIssuesAssigned}\n`;
  text += `   Total Issues Created: ${report.summary.totalIssuesCreated}\n`;
  text += `   Total Issues with Merged PRs: ${report.summary.totalIssuesWithMergedPRs}\n`;
  text += `   Total Issues Handled: ${report.summary.totalIssuesHandled}\n`;
  text += '\n';
  
  // Per-developer stats
  text += '👥 DEVELOPER STATISTICS:\n\n';
  
  if (report.teamStats.length === 0) {
    text += '   No data found for the specified criteria.\n\n';
    return text;
  }
  
  // Calculate column widths
  const maxNameLength = Math.max(
    ...report.teamStats.map(s => s.userName.length),
    'Developer Name'.length
  );
  
  // Header
  text += '   ' + 
    'Developer Name'.padEnd(maxNameLength + 2) + 
    'Assigned'.padStart(12) + 
    'Created'.padStart(12) + 
    'Merged PRs'.padStart(12) + 
    'Total'.padStart(12) + 
    '\n';
  text += '   ' + '-'.repeat(maxNameLength + 2 + 12 + 12 + 12 + 12) + '\n';
  
  // Data rows
  report.teamStats.forEach(stats => {
    text += '   ' + 
      stats.userName.padEnd(maxNameLength + 2) + 
      stats.assigned.toString().padStart(12) + 
      stats.created.toString().padStart(12) + 
      stats.withMergedPRs.toString().padStart(12) + 
      stats.totalHandled.toString().padStart(12) + 
      '\n';
  });
  
  text += '\n' + '='.repeat(80) + '\n';
  
  return text;
}

/**
 * Export report to text file
 */
async function exportReportToText(report, filename = null) {
  if (!report) return null;
  
  // Create reports directory if it doesn't exist
  const reportsDir = 'reports';
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (err) {
    // Directory might already exist, that's fine
  }
  
  if (!filename) {
    const dateStr = new Date().toISOString().split('T')[0];
    filename = `team_issues_report_${dateStr}.txt`;
  }
  
  const filepath = path.join(reportsDir, filename);
  const text = generateTextReport(report);
  await fs.writeFile(filepath, text, 'utf8');
  return filepath;
}

/**
 * Export report to JSON file
 */
async function exportReportToJSON(report, filename = null) {
  if (!report) return null;
  
  // Create reports directory if it doesn't exist
  const reportsDir = 'reports';
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (err) {
    // Directory might already exist, that's fine
  }
  
  if (!filename) {
    const dateStr = new Date().toISOString().split('T')[0];
    filename = `team_issues_report_${dateStr}.json`;
  }
  
  const filepath = path.join(reportsDir, filename);
  await fs.writeFile(filepath, JSON.stringify(report, null, 2), 'utf8');
  return filepath;
}

/**
 * Parse team emails from environment variable or string
 * Supports comma-separated or space-separated emails
 */
function parseTeamEmails(emailsString) {
  if (!emailsString) return [];
  
  // Split by comma or space, then trim and filter empty strings
  return emailsString
    .split(/[,\s]+/)
    .map(email => email.trim())
    .filter(email => email.length > 0);
}

/**
 * Parse month input and return month and year
 * Supports formats like: "October", "Oct", "10", "2024-10", "October 2024", "Oct 2024", "10/2024"
 */
function parseMonthInput(monthInput) {
  if (!monthInput) return null;
  
  const input = monthInput.trim().toLowerCase();
  const currentYear = new Date().getFullYear();
  let month = null;
  let year = currentYear;
  
  // Month names mapping
  const monthNames = {
    'january': 0, 'jan': 0,
    'february': 1, 'feb': 1,
    'march': 2, 'mar': 2,
    'april': 3, 'apr': 3,
    'may': 4,
    'june': 5, 'jun': 5,
    'july': 6, 'jul': 6,
    'august': 7, 'aug': 7,
    'september': 8, 'sep': 8, 'sept': 8,
    'october': 9, 'oct': 9,
    'november': 10, 'nov': 10,
    'december': 11, 'dec': 11
  };
  
  // Try to parse month name
  for (const [name, num] of Object.entries(monthNames)) {
    if (input.includes(name)) {
      month = num;
      break;
    }
  }
  
  // If not found by name, try to parse as number
  if (month === null) {
    // Try formats like "10", "2024-10", "10/2024", "2024/10"
    const numberMatch = input.match(/(\d{1,2})[\/\-]?(\d{4})?/);
    if (numberMatch) {
      const monthNum = parseInt(numberMatch[1]);
      if (monthNum >= 1 && monthNum <= 12) {
        month = monthNum - 1; // JavaScript months are 0-indexed
      }
      if (numberMatch[2]) {
        year = parseInt(numberMatch[2]);
      }
    }
  } else {
    // If we found month by name, try to extract year
    const yearMatch = input.match(/\b(20\d{2})\b/);
    if (yearMatch) {
      year = parseInt(yearMatch[1]);
    }
  }
  
  if (month === null) {
    return null;
  }
  
  return { month, year };
}

/**
 * Get start and end dates for a given month and year
 */
function getMonthDateRange(month, year) {
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999); // Last moment of the month
  
  return { startDate, endDate };
}

/**
 * Format month name for display
 */
function formatMonthName(month, year) {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return `${monthNames[month]} ${year}`;
}

// Main execution
async function main() {
  // Parse command line arguments
  // Usage: node team_issues_report.js [email1] [email2] ... [--days N] [--all] [--export]
  const args = process.argv.slice(2);
  
  let teamEmails = [];
  let daysBack = 30;
  let since = null;
  let until = null;
  let monthName = null;
  let useAllUsers = false;
  let exportJson = false;
  
  // Check for team emails in .env file first
  const envTeamEmails = process.env.TEAM_EMAILS;
  let emailsFromEnv = false;
  if (envTeamEmails) {
    teamEmails = parseTeamEmails(envTeamEmails);
    emailsFromEnv = true;
    console.log(`📧 Loaded ${teamEmails.length} team member(s) from .env file:`);
    teamEmails.forEach((email, idx) => {
      console.log(`   ${idx + 1}. ${email}`);
    });
    console.log('');
  }
  
  // Check for default days in .env file
  const envDaysBack = process.env.TEAM_DAYS_BACK;
  if (envDaysBack && !args.includes('--days') && !args.includes('--month')) {
    const parsedDays = parseInt(envDaysBack);
    if (!isNaN(parsedDays)) {
      daysBack = parsedDays;
      console.log(`📅 Using default days from .env: ${daysBack}`);
    }
  }
  
  // Parse command line arguments (these override .env values)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--all') {
      useAllUsers = true;
      teamEmails = []; // Clear emails when using --all
    } else if (arg === '--month' && i + 1 < args.length) {
      const monthInput = args[i + 1];
      const monthInfo = parseMonthInput(monthInput);
      if (!monthInfo) {
        console.error(`❌ Invalid month argument: ${monthInput}`);
        console.error('   Supported formats: "October", "Oct", "10", "2024-10", "October 2024", "Oct 2024", "10/2024"');
        process.exit(1);
      }
      const { startDate, endDate } = getMonthDateRange(monthInfo.month, monthInfo.year);
      since = startDate;
      until = endDate;
      monthName = formatMonthName(monthInfo.month, monthInfo.year);
      i++; // Skip next argument
    } else if (arg === '--days' && i + 1 < args.length) {
      const days = parseInt(args[i + 1]);
      if (isNaN(days)) {
        console.error(`❌ Invalid days argument: ${args[i + 1]}`);
        process.exit(1);
      }
      daysBack = days;
      i++; // Skip next argument
    } else if (arg === '--export' || arg === '--json') {
      exportJson = true;
    } else if (!arg.startsWith('--')) {
      // Command line emails override .env emails
      if (emailsFromEnv) {
        console.log('📧 Overriding .env emails with command line arguments');
        teamEmails = [];
        emailsFromEnv = false;
      }
      teamEmails.push(arg);
    }
  }
  
  // Determine date range
  if (monthName) {
    // Month range is already set above
    console.log(`📅 Fetching issues for ${monthName}\n`);
  } else if (daysBack === 0 || (args.includes('all') && !args.includes('--days'))) {
    since = null;
    until = null;
    console.log('📅 Fetching ALL issues (no date filter)\n');
  } else {
    since = new Date();
    since.setDate(since.getDate() - daysBack);
    until = null;
    console.log(`📅 Fetching issues from the last ${daysBack} days (since ${since.toLocaleDateString()})\n`);
  }
  
  // Determine which users to report on
  const emailsToUse = useAllUsers ? null : (teamEmails.length > 0 ? teamEmails : null);
  
  if (!useAllUsers && (!emailsToUse || emailsToUse.length === 0)) {
    console.log('ℹ️  No team emails provided.');
    console.log('\nOptions:');
    console.log('  1. Set TEAM_EMAILS in your .env file (comma or space separated)');
    console.log('  2. Use --all to report on all users');
    console.log('  3. Provide email addresses as command line arguments');
    console.log('\nUsage:');
    console.log('  node team_issues_report.js [email1] [email2] ... [--days N] [--month MONTH] [--all] [--export]');
    console.log('\nExamples:');
    console.log('  node team_issues_report.js developer1@example.com developer2@example.com');
    console.log('  node team_issues_report.js developer1@example.com --days 60');
    console.log('  node team_issues_report.js --all --days 30');
    console.log('  node team_issues_report.js --all --month October');
    console.log('  node team_issues_report.js --all --month "October 2024"');
    console.log('  node team_issues_report.js --all --month 10/2024');
    console.log('  node team_issues_report.js --all --export');
    console.log('\nMonth formats supported:');
    console.log('  "October", "Oct", "10", "2024-10", "October 2024", "Oct 2024", "10/2024"');
    console.log('\n.env file example:');
    console.log('  TEAM_EMAILS=developer1@example.com,developer2@example.com,developer3@example.com');
    console.log('  TEAM_DAYS_BACK=30');
    console.log('');
    process.exit(1);
  }
  
  try {
    const report = await generateTeamIssuesReport(emailsToUse, { since, until, monthName, limit: 250 });
    
    if (!report) {
      console.error('❌ Failed to generate report');
      process.exit(1);
    }
    
    // Display report
    displayReport(report);
    
    // Export to file
    const spinner = createSpinner('Saving report');
    spinner.start();
    
    try {
      // Generate filename with month if applicable
      let textFilename = null;
      let jsonFilename = null;
      if (monthName) {
        const monthSlug = monthName.toLowerCase().replace(/\s+/g, '_');
        textFilename = `team_issues_report_${monthSlug}.txt`;
        if (exportJson) {
          jsonFilename = `team_issues_report_${monthSlug}.json`;
        }
      }
      
      const textFile = await exportReportToText(report, textFilename);
      spinner.stop();
      console.log(`✅ Text report saved to: ${textFile}`);
      
      if (exportJson) {
        const jsonFile = await exportReportToJSON(report, jsonFilename);
        console.log(`✅ JSON report saved to: ${jsonFile}`);
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

// Run if this file is executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     process.argv[1]?.endsWith('team_issues_report.js');
if (isMainModule) {
  main();
}

export { 
  generateTeamIssuesReport, 
  displayReport, 
  exportReportToText, 
  exportReportToJSON,
  getUserIssueStats 
};

