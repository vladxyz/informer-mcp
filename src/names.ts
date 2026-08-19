/**
 * Tool names, kept in one place because error messages point at them.
 *
 * A tool nobody reaches for might as well not exist, so the failures that a tool
 * fixes name it explicitly: a 401 tells you to open the setup page, and an
 * unknown argument tells you to refresh the API description.
 */

export const SETUP_TOOL = 'open_setup';
export const REFRESH_TOOL = 'refresh_api_spec';
export const LIST_ADMINISTRATIONS_TOOL = 'list_administrations';
