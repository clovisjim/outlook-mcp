/**
 * Create event functionality
 */
const { callGraphAPI } = require('../utils/graph-api');
const { ensureAuthenticated } = require('../auth');
const { DEFAULT_TIMEZONE } = require('../config');

/**
 * Create event handler
 * @param {object} args - Tool arguments
 * @returns {object} - MCP response
 */
async function handleCreateEvent(args) {
  const { subject, start, end, attendees, body, location, timeZone } = args;

  if (!subject || !start || !end) {
    return {
      content: [{
        type: "text",
        text: "Subject, start, and end times are required to create an event."
      }]
    };
  }

  try {
    // Get access token
    const accessToken = await ensureAuthenticated();

    // Build API endpoint
    const endpoint = `me/events`;

    // Resolve the effective timezone:
    // 1. Top-level timeZone argument (explicit override)
    // 2. Nested object format: start.timeZone / end.timeZone
    // 3. DEFAULT_TIMEZONE from config (Mountain Standard Time)
    const resolvedTZ = timeZone || DEFAULT_TIMEZONE;

    const startDateTime = typeof start === 'object' ? start.dateTime : start;
    const startTZ = (typeof start === 'object' && start.timeZone) ? start.timeZone : resolvedTZ;

    const endDateTime = typeof end === 'object' ? end.dateTime : end;
    const endTZ = (typeof end === 'object' && end.timeZone) ? end.timeZone : resolvedTZ;

    // Request body
    const bodyContent = {
      subject,
      start: { dateTime: startDateTime, timeZone: startTZ },
      end: { dateTime: endDateTime, timeZone: endTZ },
      attendees: attendees?.map(email => ({ emailAddress: { address: email }, type: "required" })),
      body: { contentType: "HTML", content: body || "" },
      ...(location ? { location: { displayName: location } } : {})
    };

    // Make API call
    const response = await callGraphAPI(accessToken, 'POST', endpoint, bodyContent);

    return {
      content: [{
        type: "text",
        text: `Event '${subject}' has been successfully created.`
      }]
    };
  } catch (error) {
    if (error.message === 'Authentication required') {
      return {
        content: [{
          type: "text",
          text: "Authentication required. Please use the 'authenticate' tool first."
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: `Error creating event: ${error.message}`
      }]
    };
  }
}

module.exports = handleCreateEvent;
