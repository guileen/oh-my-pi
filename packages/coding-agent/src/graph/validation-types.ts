export interface GraphIssue {
	/** JSON Pointer to the offending front matter value. */
	path: string;
	message: string;
}
